import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rate_adapter import RateService, RateUnavailable, create_server


def payload():
    return json.dumps({'success': True, 'code': '000000', 'data': {'asset': 'USDT', 'fiat': 'CNY', 'price': 6.7}}).encode()


class RateSafetyTests(unittest.TestCase):
    def test_published_expiry_boundary_refreshes_before_returning_cached_quote(self):
        now = [100.875]
        calls = [0]
        def fetch():
            calls[0] += 1
            return payload()
        service = RateService(fetch, clock=lambda: now[0], cache_ttl=60, max_age=300)
        first = service.get_cny_rate()
        now[0] = 159.5
        second = service.get_cny_rate()
        self.assertEqual(calls[0], 2)
        self.assertNotEqual(first['expires_at'], second['expires_at'])

    def test_published_expiry_boundary_failure_does_not_serve_cached_quote(self):
        now = [100.875]
        calls = [0]
        def fetch():
            calls[0] += 1
            if calls[0] == 1:
                return payload()
            raise OSError('offline')
        service = RateService(fetch, clock=lambda: now[0], cache_ttl=60, max_age=300)
        service.get_cny_rate()
        now[0] = 160.1
        self.assertFalse(service.health()['ready'])
        with self.assertRaises(RateUnavailable):
            service.get_cny_rate()

    def test_expired_quote_is_not_returned_as_success_on_refresh_failure(self):
        now = [100.0]
        calls = [0]
        def fetch():
            calls[0] += 1
            if calls[0] == 1:
                return payload()
            raise OSError('offline')
        service = RateService(fetch, clock=lambda: now[0], cache_ttl=60, max_age=300)
        service.get_cny_rate()
        now[0] = 161.0
        with self.assertRaises(RateUnavailable):
            service.get_cny_rate()

    def test_refresh_failure_crossing_maximum_age_fails_closed(self):
        now = [100.0]
        calls = [0]
        def fetch():
            calls[0] += 1
            if calls[0] == 1:
                return payload()
            now[0] = 405.0
            raise OSError('timeout')
        service = RateService(fetch, clock=lambda: now[0], cache_ttl=60, max_age=300)
        service.get_cny_rate()
        now[0] = 399.0
        with self.assertRaises(RateUnavailable):
            service.get_cny_rate()

    def test_slow_connections_cannot_create_unbounded_request_threads(self):
        server = create_server('127.0.0.1', 0, RateService(payload))
        runner = threading.Thread(target=server.serve_forever, daemon=True)
        before = {t.ident for t in threading.enumerate()}
        runner.start()
        sockets = []
        try:
            for _ in range(24):
                conn = socket.create_connection(server.server_address, timeout=2)
                conn.sendall(b'GET /health HTTP/1.1\r\n')
                sockets.append(conn)
            end = time.monotonic() + 1.0
            while time.monotonic() < end:
                workers = [t for t in threading.enumerate() if t.ident not in before and 'process_request_thread' in t.name]
                if len(workers) > 16:
                    break
                time.sleep(0.01)
            self.assertLessEqual(len(workers), 16)
        finally:
            for conn in sockets:
                conn.close()
            server.shutdown()
            server.server_close()
            runner.join(2)


if __name__ == '__main__':
    unittest.main()
