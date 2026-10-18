"""Local read-only Binance CNY/USDT rate adapter."""

from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18084
DEFAULT_TIMEOUT_SECONDS = 5.0
DEFAULT_CACHE_TTL_SECONDS = 60.0
DEFAULT_MAX_AGE_SECONDS = 300.0
DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024
BINANCE_QUOTE_URL = (
    "https://www.binance.com/bapi/c2c/v1/public/c2c/agent/quote-price"
)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, hdrs: Any, newurl: str) -> Any:
        raise QuoteError("Binance redirect rejected")


DEFAULT_OPENER = urllib.request.build_opener(_NoRedirectHandler()).open


class QuoteError(ValueError):
    """Raised when an upstream quote is unusable."""


@dataclass(frozen=True)
class ParsedQuote:
    cny_per_usdt: float
    usdt_per_cny: float


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise QuoteError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_nonfinite_constant(value: str) -> object:
    raise QuoteError(f"non-finite JSON value: {value}")


def parse_binance_quote(
    payload: str | bytes,
    *,
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> ParsedQuote:
    if isinstance(payload, str):
        raw_payload = payload.encode("utf-8")
    elif isinstance(payload, bytes):
        raw_payload = payload
    else:
        raise QuoteError("Binance response must be text or bytes")
    if len(raw_payload) > max_response_bytes:
        raise QuoteError("Binance response is too large")
    try:
        document = json.loads(
            raw_payload,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_nonfinite_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        if isinstance(exc, QuoteError):
            raise
        raise QuoteError("invalid Binance JSON") from exc

    if not isinstance(document, dict):
        raise QuoteError("Binance response must be an object")
    if document.get("success") is not True:
        raise QuoteError("Binance response was not successful")
    if document.get("code") != "000000":
        raise QuoteError("Binance response code was not 000000")

    data = document.get("data")
    if not isinstance(data, dict):
        raise QuoteError("Binance response data must be an object")
    if data.get("asset") != "USDT" or data.get("fiat") != "CNY":
        raise QuoteError("Binance quote asset/fiat mismatch")

    price = data.get("price")
    if isinstance(price, bool) or not isinstance(price, (int, float)):
        raise QuoteError("Binance price must be numeric")
    try:
        price = float(price)
    except (OverflowError, ValueError) as exc:
        raise QuoteError("Binance price must be finite and positive") from exc
    if not math.isfinite(price) or price <= 0:
        raise QuoteError("Binance price must be finite and positive")
    usdt_per_cny = 1.0 / price
    if not math.isfinite(usdt_per_cny) or usdt_per_cny <= 0:
        raise QuoteError("converted rate must be finite and positive")
    return ParsedQuote(cny_per_usdt=price, usdt_per_cny=usdt_per_cny)


class RateUnavailable(RuntimeError):
    """Raised when no quote within the configured maximum age is available."""


class BinanceQuoteFetcher:
    """Fetch the one fixed public Binance BUY quote."""

    def __init__(
        self,
        *,
        opener: Callable[..., Any] = DEFAULT_OPENER,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
    ) -> None:
        if timeout <= 0 or not math.isfinite(timeout):
            raise ValueError("timeout must be finite and positive")
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be positive")
        self._opener = opener
        self._timeout = timeout
        self._max_response_bytes = max_response_bytes

    def __call__(self) -> bytes:
        query = urllib.parse.urlencode(
            {"asset": "USDT", "fiat": "CNY", "tradeType": "BUY"}
        )
        request = urllib.request.Request(
            f"{BINANCE_QUOTE_URL}?{query}",
            headers={"Accept": "application/json", "User-Agent": "epusdt-rate-adapter/1"},
            method="GET",
        )
        try:
            with self._opener(request, timeout=self._timeout) as response:
                status = getattr(response, "status", None)
                if status is None:
                    status = response.getcode()
                if status < 200 or status >= 300:
                    raise QuoteError(f"Binance HTTP status {status}")
                body = response.read(self._max_response_bytes + 1)
        except QuoteError:
            raise
        except (OSError, urllib.error.URLError, TimeoutError) as exc:
            raise QuoteError("Binance request failed") from exc
        if not isinstance(body, bytes):
            raise QuoteError("Binance response body was not bytes")
        if len(body) > self._max_response_bytes:
            raise QuoteError("Binance response is too large")
        return body


@dataclass(frozen=True)
class _Snapshot:
    quote: ParsedQuote
    fetched_at: float


class RateService:
    """Thread-safe TTL cache with one in-flight refresh at a time."""

    def __init__(
        self,
        fetcher: Callable[[], bytes],
        *,
        clock: Callable[[], float] = time.time,
        cache_ttl: float = DEFAULT_CACHE_TTL_SECONDS,
        max_age: float = DEFAULT_MAX_AGE_SECONDS,
        cache_path: str | os.PathLike[str] | None = None,
    ) -> None:
        if cache_ttl <= 0 or not math.isfinite(cache_ttl):
            raise ValueError("cache_ttl must be finite and positive")
        if max_age < cache_ttl or not math.isfinite(max_age):
            raise ValueError("max_age must be finite and at least cache_ttl")
        self._fetcher = fetcher
        self._clock = clock
        self._cache_ttl = cache_ttl
        self._max_age = max_age
        self._cache_path = Path(cache_path) if cache_path else None
        self._condition = threading.Condition()
        self._snapshot: _Snapshot | None = None
        self._refreshing = False
        self._refresh_generation = 0
        self._last_failure_generation: int | None = None
        self._last_error: str | None = None
        self._load_cache()

    def _load_cache(self) -> None:
        if self._cache_path is None:
            return
        try:
            raw = self._cache_path.read_bytes()
            if len(raw) > DEFAULT_MAX_RESPONSE_BYTES:
                return
            document = json.loads(
                raw,
                object_pairs_hook=_reject_duplicate_keys,
                parse_constant=_reject_nonfinite_constant,
            )
            if not isinstance(document, dict):
                return
            fetched_at = document.get("fetched_at")
            price = document.get("cny_per_usdt")
            rate = document.get("usdt_per_cny")
            if (
                isinstance(fetched_at, bool)
                or not isinstance(fetched_at, (int, float))
                or isinstance(price, bool)
                or not isinstance(price, (int, float))
                or isinstance(rate, bool)
                or not isinstance(rate, (int, float))
            ):
                return
            try:
                fetched_at = float(fetched_at)
                price = float(price)
                rate = float(rate)
            except (OverflowError, ValueError):
                return
            now = self._clock()
            if (
                not math.isfinite(fetched_at)
                or not math.isfinite(price)
                or not math.isfinite(rate)
                or price <= 0
                or rate <= 0
                or fetched_at > now
                or now - fetched_at > self._max_age
                or not math.isclose(rate, 1.0 / price, rel_tol=1e-12, abs_tol=0.0)
            ):
                return
            with self._condition:
                self._snapshot = _Snapshot(
                    quote=ParsedQuote(price, rate), fetched_at=fetched_at
                )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return

    def _persist(self, snapshot: _Snapshot) -> None:
        if self._cache_path is None:
            return
        payload = {
            "version": 1,
            "cny_per_usdt": snapshot.quote.cny_per_usdt,
            "usdt_per_cny": snapshot.quote.usdt_per_cny,
            "fetched_at": snapshot.fetched_at,
        }
        target = self._cache_path
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(
            f".{target.name}.{os.getpid()}.{threading.get_ident()}.tmp"
        )
        try:
            with temp.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, separators=(",", ":"), allow_nan=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, target)
        finally:
            try:
                temp.unlink()
            except FileNotFoundError:
                pass

    @staticmethod
    def _iso8601(timestamp: float) -> str:
        return (
            datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        )

    def _age(self, snapshot: _Snapshot | None, now: float) -> float:
        if snapshot is None:
            return math.inf
        return max(0.0, now - snapshot.fetched_at)

    def _public(self, snapshot: _Snapshot) -> dict[str, Any]:
        expires_at = snapshot.fetched_at + self._cache_ttl
        return {
            "cny": {"usdt": snapshot.quote.usdt_per_cny},
            "source": "binance-p2p",
            "trade_type": "BUY",
            "cny_per_usdt": snapshot.quote.cny_per_usdt,
            "fetched_at": self._iso8601(snapshot.fetched_at),
            "expires_at": self._iso8601(expires_at),
        }

    def _refresh(self) -> _Snapshot:
        parsed = parse_binance_quote(self._fetcher())
        snapshot = _Snapshot(parsed, self._clock())
        self._persist(snapshot)
        return snapshot

    def get_cny_rate(self) -> dict[str, Any]:
        """Return only a fresh quote; failed refreshes never extend its validity."""
        waited_generation: int | None = None
        while True:
            with self._condition:
                now = self._clock()
                snapshot = self._snapshot
                age = self._age(snapshot, now)
                if snapshot is not None and 0 <= now - snapshot.fetched_at < self._cache_ttl:
                    return self._public(snapshot)
                if self._refreshing:
                    waited_generation = self._refresh_generation
                    self._condition.wait(timeout=DEFAULT_TIMEOUT_SECONDS + 1)
                    if self._refreshing:
                        raise RateUnavailable("CNY rate refresh is still pending")
                    continue
                if (
                    waited_generation is not None
                    and self._last_failure_generation == waited_generation
                ):
                    raise RateUnavailable("CNY rate is not ready")
                self._refresh_generation += 1
                self._refreshing = True
                refresh_generation = self._refresh_generation

            try:
                refreshed = self._refresh()
            except Exception as exc:
                with self._condition:
                    self._last_error = str(exc) or exc.__class__.__name__
                    self._last_failure_generation = refresh_generation
                    self._refreshing = False
                    self._condition.notify_all()
                raise RateUnavailable("CNY rate is not ready") from exc
            else:
                with self._condition:
                    self._snapshot = refreshed
                    self._last_error = None
                    self._last_failure_generation = None
                    self._refreshing = False
                    self._condition.notify_all()
                    return self._public(refreshed)

    def health(self) -> dict[str, Any]:
        with self._condition:
            now = self._clock()
            snapshot = self._snapshot
            age = self._age(snapshot, now)
            ready = snapshot is not None and 0 <= now - snapshot.fetched_at < self._cache_ttl
            stale = snapshot is not None and not ready
            if not ready:
                status = "not_ready"
            elif stale:
                status = "stale"
            else:
                status = "healthy"
            result: dict[str, Any] = {
                "status": status,
                "ready": ready,
                "stale": stale,
                "refreshing": self._refreshing,
            }
            if self._last_error:
                result["last_error"] = self._last_error
            if snapshot is not None:
                result["fetched_at"] = self._iso8601(snapshot.fetched_at)
                result["expires_at"] = self._iso8601(snapshot.fetched_at + self._cache_ttl)
            return result


class _RateRequestHandler(BaseHTTPRequestHandler):
    server: "RateHTTPServer"

    def setup(self) -> None:
        self.request.settimeout(5.0)
        super().setup()

    def _write_json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/rates/usd.json":
            self._write_json(HTTPStatus.OK, {"usd": {"usdt": 1}})
            return
        if path == "/health":
            self._write_json(HTTPStatus.OK, self.server.rate_service.health())
            return
        if path == "/rates/cny.json":
            try:
                body = self.server.rate_service.get_cny_rate()
            except RateUnavailable:
                self._write_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    {"error": "rate_unavailable"},
                )
                return
            self._write_json(HTTPStatus.OK, body)
            return
        self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        self._write_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"})

    def log_message(self, format: str, *args: object) -> None:
        return


class RateHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], rate_service: RateService) -> None:
        self.rate_service = rate_service
        self._request_slots = threading.BoundedSemaphore(16)
        super().__init__(address, _RateRequestHandler)

    def process_request(self, request, client_address) -> None:
        if not self._request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._request_slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


def create_server(
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    service: RateService | None = None,
) -> RateHTTPServer:
    if host != DEFAULT_HOST:
        raise ValueError("the adapter only binds to 127.0.0.1")
    if not isinstance(port, int) or isinstance(port, bool) or not 0 <= port <= 65535:
        raise ValueError("port must be between 0 and 65535")
    if service is None:
        service = RateService(BinanceQuoteFetcher())
    return RateHTTPServer((host, port), service)


def _positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be finite and positive")
    return parsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("EPUSDT_RATE_PORT", DEFAULT_PORT)),
    )
    parser.add_argument(
        "--timeout",
        type=_positive_float,
        default=_positive_float(
            os.environ.get("EPUSDT_RATE_TIMEOUT", str(DEFAULT_TIMEOUT_SECONDS))
        ),
    )
    parser.add_argument(
        "--cache-ttl",
        type=_positive_float,
        default=_positive_float(
            os.environ.get("EPUSDT_RATE_CACHE_TTL", str(DEFAULT_CACHE_TTL_SECONDS))
        ),
    )
    parser.add_argument(
        "--max-age",
        type=_positive_float,
        default=_positive_float(
            os.environ.get("EPUSDT_RATE_MAX_AGE", str(DEFAULT_MAX_AGE_SECONDS))
        ),
    )
    parser.add_argument("--cache-file", default=os.environ.get("EPUSDT_RATE_CACHE_FILE"))
    args = parser.parse_args(argv)
    if args.max_age < args.cache_ttl:
        parser.error("--max-age must be at least --cache-ttl")
    service = RateService(
        BinanceQuoteFetcher(timeout=args.timeout),
        cache_ttl=args.cache_ttl,
        max_age=args.max_age,
        cache_path=args.cache_file,
    )
    server = create_server(DEFAULT_HOST, args.port, service)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
