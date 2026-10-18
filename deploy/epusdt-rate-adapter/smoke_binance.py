"""Opt-in live Binance connectivity smoke; never used by the unit suite."""

from __future__ import annotations

import json
import sys

from rate_adapter import BinanceQuoteFetcher, parse_binance_quote


def main() -> int:
    try:
        quote = parse_binance_quote(BinanceQuoteFetcher()())
    except Exception as exc:  # noqa: BLE001 - smoke must report any network failure
        print(f"network smoke: FAIL: {exc}")
        return 1
    print(
        "network smoke: PASS: "
        + json.dumps(
            {
                "asset": "USDT",
                "fiat": "CNY",
                "trade_type": "BUY",
                "cny_per_usdt": quote.cny_per_usdt,
                "usdt_per_cny": quote.usdt_per_cny,
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
