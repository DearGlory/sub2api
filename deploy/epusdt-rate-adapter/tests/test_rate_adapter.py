import json
import sys
import tempfile
import threading
from pathlib import Path
import unittest
from unittest import mock


SERVICE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_DIR))

from rate_adapter import (  # noqa: E402
    BinanceQuoteFetcher,
    QuoteError,
    RateService,
    RateUnavailable,
    _NoRedirectHandler,
    create_server,
    parse_binance_quote,
)


class BinanceQuoteParsingTests(unittest.TestCase):
    def test_rejects_duplicate_keys(self):
        payload = b'{"success":true,"success":true,"code":"000000"}'
        with self.assertRaises(QuoteError):
            parse_binance_quote(payload)

    def test_rejects_unsuccessful_or_mismatched_envelope(self):
        valid = {
            "success": True,
            "code": "000000",
            "data": {"asset": "USDT", "fiat": "CNY", "price": 6.7},
        }
        for field, value in [("success", False), ("success", 1), ("code", "-1")]:
            with self.subTest(field=field, value=value):
                payload = dict(valid)
                payload[field] = value
                with self.assertRaises(QuoteError):
                    parse_binance_quote(json.dumps(payload))
        for field, value in [("asset", "BTC"), ("fiat", "USD")]:
            with self.subTest(field=field, value=value):
                payload = dict(valid)
                payload["data"] = dict(valid["data"])
                payload["data"][field] = value
                with self.assertRaises(QuoteError):
                    parse_binance_quote(json.dumps(payload))

        for price in [True, "6.7", 0, -1, float("nan"), float("inf")]:
            with self.subTest(price=price):
                payload = json.dumps(
                    {
                        "success": True,
                        "code": "000000",
                        "data": {"asset": "USDT", "fiat": "CNY", "price": price},
                    },
                    allow_nan=True,
                )
                with self.assertRaises(QuoteError):
                    parse_binance_quote(payload)

    def test_rejects_oversized_response(self):
        with self.assertRaises(QuoteError):
            parse_binance_quote(" " * 65, max_response_bytes=64)

    def test_valid_binance_cny_usdt_quote_is_converted_to_usdt_per_cny(self):
        payload = json.dumps(
            {
                "success": True,
                "code": "000000",
                "data": {
                    "asset": "USDT",
                    "fiat": "CNY",
                    "price": 6.7,
                },
            }
        )

        quote = parse_binance_quote(payload)

        self.assertEqual(quote.cny_per_usdt, 6.7)
        self.assertAlmostEqual(quote.usdt_per_cny, 1 / 6.7)
        self.assertEqual(67 * quote.usdt_per_cny, 10)


class RateServiceTests(unittest.TestCase):
    @staticmethod
    def _payload(price=6.7):
        return json.dumps(
            {
                "success": True,
                "code": "000000",
                "data": {"asset": "USDT", "fiat": "CNY", "price": price},
            }
        ).encode()

    def test_cold_start_failure_is_unavailable_and_health_is_not_ready(self):
        fetcher = mock.Mock(side_effect=OSError("offline"))
        service = RateService(fetcher, clock=lambda: 100.0, cache_ttl=60, max_age=300)

        with self.assertRaises(RateUnavailable):
            service.get_cny_rate()

        self.assertFalse(service.health()["ready"])
        self.assertEqual(service.health()["status"], "not_ready")

    def test_successful_quote_is_cached_until_ttl_then_refreshes(self):
        fetcher = mock.Mock(side_effect=[self._payload(6.7), self._payload(6.8)])
        now = [100.0]
        service = RateService(fetcher, clock=lambda: now[0], cache_ttl=60, max_age=300)

        first = service.get_cny_rate()
        now[0] = 120.0
        second = service.get_cny_rate()
        now[0] = 161.0
        third = service.get_cny_rate()

        self.assertEqual(first["cny_per_usdt"], 6.7)
        self.assertEqual(second, first)
        self.assertEqual(third["cny_per_usdt"], 6.8)
        self.assertEqual(fetcher.call_count, 2)

    def test_cache_snapshot_is_written_atomically_and_reloaded(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / "state" / "quote.json"
            now = [100.0]
            service = RateService(
                lambda: self._payload(6.7),
                clock=lambda: now[0],
                cache_ttl=60,
                max_age=300,
                cache_path=cache_path,
            )
            service.get_cny_rate()
            persisted = json.loads(cache_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["cny_per_usdt"], 6.7)
            self.assertEqual(persisted["usdt_per_cny"], 1 / 6.7)
            reloaded = RateService(
                lambda: (_ for _ in ()).throw(OSError("offline")),
                clock=lambda: now[0],
                cache_ttl=60,
                max_age=300,
                cache_path=cache_path,
            )
            self.assertEqual(reloaded.get_cny_rate()["cny_per_usdt"], 6.7)
            self.assertEqual(list(cache_path.parent.glob("*.tmp")), [])

        entered = threading.Event()
        release = threading.Event()
        calls = []

        def fetch():
            calls.append(1)
            entered.set()
            release.wait(2)
            raise OSError("offline")

        service = RateService(fetch, clock=lambda: 100.0, cache_ttl=60, max_age=300)
        errors = []

        def worker():
            try:
                service.get_cny_rate()
            except RateUnavailable as exc:
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        self.assertTrue(entered.wait(1))
        release.set()
        for thread in threads:
            thread.join(2)

        self.assertEqual(len(calls), 1)
        self.assertEqual(len(errors), 8)

    def test_expired_snapshot_concurrent_refresh_failure_is_singleflight(self):
        entered = threading.Event()
        release = threading.Event()
        calls = []
        now = [100.0]

        def fetch():
            calls.append(1)
            if len(calls) == 1:
                return self._payload(6.7)
            entered.set()
            release.wait(2)
            raise OSError("offline")

        service = RateService(fetch, clock=lambda: now[0], cache_ttl=60, max_age=300)
        service.get_cny_rate()
        now[0] = 401.0
        errors = []

        def worker():
            try:
                service.get_cny_rate()
            except RateUnavailable as exc:
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        self.assertTrue(entered.wait(1))
        release.set()
        for thread in threads:
            thread.join(2)

        self.assertEqual(len(calls), 2)
        self.assertEqual(len(errors), 8)

        fetcher = mock.Mock(side_effect=[self._payload(6.7), OSError("offline")])
        now = [100.0]
        service = RateService(fetcher, clock=lambda: now[0], cache_ttl=60, max_age=300)

        service.get_cny_rate()
        now[0] = 161.0
        with self.assertRaises(RateUnavailable):
            service.get_cny_rate()
        self.assertTrue(service.health()["stale"])
        self.assertFalse(service.health()["ready"])
        self.assertEqual(fetcher.call_count, 2)

        now[0] = 401.0
        with self.assertRaises(RateUnavailable):
            service.get_cny_rate()
        self.assertFalse(service.health()["ready"])

    def test_concurrent_cold_start_uses_one_upstream_request(self):
        entered = threading.Event()
        release = threading.Event()
        calls = []

        def fetch():
            calls.append(1)
            entered.set()
            release.wait(2)
            return self._payload(6.7)

        service = RateService(fetch, clock=lambda: 100.0, cache_ttl=60, max_age=300)
        results = []
        errors = []

        def worker():
            try:
                results.append(service.get_cny_rate())
            except Exception as exc:  # pragma: no cover - assertion below
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        self.assertTrue(entered.wait(1))
        release.set()
        for thread in threads:
            thread.join(2)

        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 8)
        self.assertEqual(errors, [])


class HttpApiTests(unittest.TestCase):
    def test_cny_and_legacy_usd_contracts_and_health(self):
        service = RateService(lambda: RateServiceTests._payload(6.7), clock=lambda: 100.0)
        server = create_server("127.0.0.1", 0, service)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(thread.join, 1)
        import urllib.request

        base = f"http://127.0.0.1:{server.server_port}"
        with urllib.request.urlopen(base + "/rates/cny.json") as response:
            body = json.load(response)
        self.assertEqual(body["source"], "binance-p2p")
        self.assertEqual(body["trade_type"], "BUY")
        self.assertEqual(body["cny"]["usdt"], 1 / 6.7)

        with urllib.request.urlopen(base + "/rates/usd.json") as response:
            self.assertEqual(json.load(response), {"usd": {"usdt": 1}})
        with urllib.request.urlopen(base + "/health") as response:
            self.assertEqual(json.load(response)["status"], "healthy")

    def test_cny_failure_returns_503_and_health_not_ready(self):
        service = RateService(lambda: (_ for _ in ()).throw(OSError("offline")))
        server = create_server("127.0.0.1", 0, service)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(thread.join, 1)
        import urllib.error
        import urllib.request

        base = f"http://127.0.0.1:{server.server_port}"
        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(base + "/rates/cny.json")
        self.assertEqual(context.exception.code, 503)
        context.exception.close()
        with urllib.request.urlopen(base + "/health") as response:
            self.assertEqual(json.load(response)["status"], "not_ready")


class BinanceFetcherTests(unittest.TestCase):
    def test_redirect_handler_rejects_cross_origin_redirects(self):
        with self.assertRaises(QuoteError):
            _NoRedirectHandler().redirect_request(
                None, None, 302, "Found", {}, "https://attacker.invalid/"
            )

    def test_fetcher_uses_fixed_binance_buy_query_and_timeout(self):
        response = mock.MagicMock()
        response.status = 200
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        response.read.return_value = RateServiceTests._payload(6.7)
        opener = mock.Mock(return_value=response)
        fetcher = BinanceQuoteFetcher(opener=opener, timeout=3, max_response_bytes=1024)

        self.assertEqual(fetcher(), response.read.return_value)
        request = opener.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://www.binance.com/bapi/c2c/v1/public/c2c/agent/quote-price?asset=USDT&fiat=CNY&tradeType=BUY",
        )
        self.assertEqual(opener.call_args.kwargs["timeout"], 3)


if __name__ == "__main__":
    unittest.main()
