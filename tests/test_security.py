import dataclasses
import hashlib
import http.client
from http.cookies import SimpleCookie
from email.message import Message
import json
import socket
import threading
import time
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from remoteview.app import Lab, LabServer, main
from remoteview.security import Policy, RateLimiter, Rejected, password_hash, check_password, origin

PASSWORD = 'test-only-password-not-for-deployment'
ENCODED = password_hash(PASSWORD)


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.cookies = {}
        self.csrf = ''
        self.start(Policy(password=ENCODED, rate_limit=1000))

    def start(self, policy):
        if hasattr(self, 'server'):
            self.server.shutdown(); self.server.server_close(); self.thread.join(); self.lab.db.close()
        self.lab = Lab(':memory:', 'http://unused.invalid', 'test-model', policy)
        self.server = LabServer(('127.0.0.1', 0), self.lab)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.02), daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.lab.db.close()

    def request(self, path, body=None, headers=None, method=None, use_cookies=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        merged = {}
        if use_cookies and self.cookies:
            merged['Cookie'] = '; '.join(f'{k}={v}' for k, v in self.cookies.items())
        if body is not None:
            merged.update({'Content-Type': 'application/json', 'X-CSRF-Token': self.csrf})
        merged.update(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        connection.request(method or ('POST' if body is not None else 'GET'), path, data, merged)
        response = connection.getresponse()
        status, returned_headers = response.status, response.getheaders()
        raw = response.read()
        connection.close()
        for name, value in returned_headers:
            if name.lower() == 'set-cookie':
                parsed = SimpleCookie(value)
                for key, item in parsed.items():
                    if item['max-age'] == '0':
                        self.cookies.pop(key, None)
                    else:
                        self.cookies[key] = item.value
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeError):
            result = raw
        if isinstance(result, dict) and 'csrf_token' in result:
            self.csrf = result['csrf_token']
        return status, dict(returned_headers), result

    def login(self, headers=None):
        self.assertEqual(self.request('/api/auth', headers=headers)[0], 200)
        response = self.request('/api/login', {'password': PASSWORD}, headers)
        self.assertEqual(response[0], 200)
        return response

    def raw_request(self, data):
        with socket.create_connection(('127.0.0.1', self.port), timeout=3) as connection:
            connection.sendall(data)
            connection.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        result = b''.join(chunks)
        return int(result.split(b' ', 2)[1]), result

    def test_public_deployment_fails_closed_without_required_controls(self):
        for overrides in ({}, {'password': ENCODED}, {'password': ENCODED, 'secure_cookies': True},
                          {'password': ENCODED, 'secure_cookies': True, 'trusted_proxies': ('127.0.0.1/32',), 'trusted_hosts': ('localhost',)}):
            with self.assertRaises(ValueError):
                Policy(public_origin='https://airemoteview.buzz', **overrides)
        with self.assertRaises(ValueError):
            Policy(trusted_hosts=('airemoteview.buzz',))
        with self.assertRaises(ValueError):
            Policy(password='plaintext-secret')
        with self.assertRaises(ValueError):
            Policy(trusted_proxies=('127.0.0.1/24',))
        with self.assertRaises(ValueError):
            Policy(max_body=1048577)

    def test_production_service_requires_public_configuration(self):
        import os
        with patch.dict(os.environ, {'SKIP_DOTENV': '1', 'REQUIRE_PUBLIC_CONFIG': '1'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'Production service requires'):
                main()

    def test_password_hashing_and_constant_format(self):
        self.assertTrue(check_password(PASSWORD, ENCODED))
        self.assertFalse(check_password('wrong', ENCODED))
        self.assertFalse(check_password(None, ENCODED))
        self.assertFalse(check_password('x' * 1025, ENCODED))
        self.assertNotEqual(password_hash(PASSWORD), ENCODED)
        with self.assertRaises(ValueError):
            password_hash('short')

    def test_all_data_and_judging_routes_require_login(self):
        self.request('/api/auth')
        for path in ['/api/sessions', '/api/settings', '/api/dashboard', '/api/experiments', '/api/sessions/unknown',
                     '/api/sessions/unknown/audit', '/api/sessions/unknown/guidance', '/api/judge/unknown', '/api/judge/unknown/images/unknown']:
            self.assertEqual(self.request(path)[0], 401, path)
        for path in ['/api/sessions', '/api/experiments', '/api/settings', '/api/judge/unknown']:
            self.assertEqual(self.request(path, {})[0], 401, path)
        self.assertEqual(self.lab.db.execute('SELECT COUNT(*) FROM owners').fetchone()[0], 0)
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/app.js')[0], 200)

    def test_valid_login_expiry_logout_and_token_rotation(self):
        self.login()
        auth = self.cookies['rv_auth']
        self.assertEqual(self.request('/api/sessions', {})[0], 200)
        self.assertEqual(self.request('/api/sessions')[0], 200)
        self.assertIsNone(self.lab.db.execute('SELECT 1 FROM browser_auth WHERE token_hash=?', (auth,)).fetchone())
        with patch('remoteview.security.time.time', return_value=time.time() + 43201):
            self.assertEqual(self.request('/api/sessions')[0], 401)
        self.login()
        self.assertNotEqual(self.cookies['rv_auth'], auth)
        self.assertEqual(self.request('/api/logout', {})[0], 200)
        self.assertEqual(self.request('/api/sessions')[0], 401)
        self.assertIsNone(self.lab.security.authenticated_owner(auth))

    def test_csrf_required_with_or_without_origin_including_login(self):
        self.request('/api/auth')
        for headers in [{'X-CSRF-Token': ''}, {'X-CSRF-Token': 'bad'}, {'Origin': 'https://evil.example'},
                        {'Origin': 'null'}, {'Origin': f'https://127.0.0.1:{self.port}'}, {'Origin': f'http://127.0.0.1:{self.port}/path'},
                        {'Sec-Fetch-Site': 'cross-site'}]:
            self.assertEqual(self.request('/api/login', {'password': PASSWORD}, headers)[0], 403)
        self.login()
        self.assertEqual(self.request('/api/sessions', {}, {'X-CSRF-Token': ''})[0], 403)
        self.assertEqual(self.request('/api/sessions', {}, {'Origin': f'http://127.0.0.1:{self.port}'})[0], 200)
        self.assertEqual(self.request('/api/sessions', {})[0], 200)  # CLI still requires the token.

    def test_owner_cookie_and_forged_access_identity_do_not_bypass_login(self):
        self.lab.owner('a' * 64)
        self.cookies['rv_owner'] = 'a' * 64
        self.assertEqual(self.request('/api/sessions', headers={'Cf-Access-Authenticated-User-Email': 'admin@example.invalid', 'Cf-Access-Jwt-Assertion': 'forged'})[0], 401)
        self.cookies['rv_auth'] = 'f' * 64
        self.assertEqual(self.request('/api/dashboard')[0], 401)

    def test_owner_records_and_sealed_results_survive_login_and_relogin(self):
        old = 'a' * 64
        self.lab.owner(old)
        record = self.lab.act('POST', '/api/sessions', {}, old)
        path = '/api/sessions/' + record['id']
        self.lab.act('POST', path + '/impressions', {'text': '  exact original  '}, old)
        sealed = self.lab.act('POST', path + '/finalize', {}, old)
        self.cookies['rv_owner'] = old
        self.login()
        first_auth = self.cookies['rv_auth']
        self.assertEqual(self.request(path)[2], sealed)
        self.login()
        self.assertEqual(self.request(path)[2], sealed)
        self.assertIsNone(self.lab.security.authenticated_owner(first_auth))
        self.assertEqual(self.request(path + '/impressions', {'text': 'new'})[0], 400)
        self.assertEqual(self.request(path + '/reveal', {})[0], 200)

    def test_secure_login_upgrades_legacy_owner_and_preserves_completed_results(self):
        self.start(Policy(trusted_hosts=('localhost', '127.0.0.1', 'airemoteview.buzz'), trusted_proxies=('127.0.0.1/32',),
                          public_origin='https://airemoteview.buzz', password=ENCODED, secure_cookies=True))
        legacy_owner = 'b' * 64
        self.lab.owner(legacy_owner)
        session = self.lab.act('POST', '/api/sessions', {}, legacy_owner)
        path = '/api/sessions/' + session['id']
        self.lab.act('POST', path + '/impressions', {'text': 'Legacy private observation'}, legacy_owner)
        sealed = self.lab.act('POST', path + '/finalize', {}, legacy_owner)
        assignment = self.lab.act('POST', path + '/judging', {}, legacy_owner)
        view = self.lab.research.judge(assignment['token'])
        self.lab.research.judge(assignment['token'], [c['id'] for c in view['candidates']])
        # Include a completed autonomous result to exercise the sealed-result owner-transfer path.
        self.lab.ollama = lambda url, body=None: {'models': [{'name': 'test-model'}]} if body is None else {'message': {'content': 'A smooth curve.'}}
        experiment = self.lab.act('POST', '/api/experiments', {}, legacy_owner)
        judgment_before = self.lab.db.execute('SELECT candidates,answer,ranking,submitted_at,hit FROM judgments WHERE session_id=?', (session['id'],)).fetchone()
        self.cookies['rv_owner'] = legacy_owner
        headers = {'Host': 'airemoteview.buzz', 'X-Forwarded-Proto': 'https'}
        self.login(headers)
        self.assertNotIn('rv_owner', self.cookies)
        self.assertNotEqual(self.cookies['__Host-rv_owner'], legacy_owner)
        self.assertEqual(self.request(path, headers=headers)[2], sealed)
        self.assertEqual(self.request('/api/experiments/' + experiment['id'], headers=headers)[2], experiment)
        self.assertIsNone(self.lab.db.execute('SELECT 1 FROM owners WHERE id=?', (legacy_owner,)).fetchone())
        self.assertEqual(tuple(judgment_before), tuple(self.lab.db.execute('SELECT candidates,answer,ranking,submitted_at,hit FROM judgments WHERE session_id=?', (session['id'],)).fetchone()))
        for sql in ["UPDATE experiments SET response='changed'", "UPDATE judgments SET answer='changed' WHERE submitted_at IS NOT NULL"]:
            with self.assertRaises(__import__('sqlite3').IntegrityError):
                self.lab.db.execute(sql)

    def test_authenticated_browser_isolation_remains(self):
        self.login()
        record = self.request('/api/sessions', {})[2]
        first_cookies = self.cookies.copy()
        self.cookies = {}; self.csrf = ''
        self.login()
        self.assertEqual(self.request('/api/sessions/' + record['id'])[0], 404)
        self.assertEqual(self.request('/api/sessions')[2], [])
        self.cookies = first_cookies
        self.assertEqual(self.request('/api/sessions/' + record['id'])[0], 200)

    def test_forwarded_headers_are_ignored_without_explicit_proxy_trust(self):
        headers = Message()
        headers['Host'] = 'localhost:18000'
        headers['X-Forwarded-Proto'] = 'https'
        headers['CF-Connecting-IP'] = '198.51.100.1'
        headers['X-Forwarded-For'] = '198.51.100.2'
        headers['X-Forwarded-Host'] = 'airemoteview.buzz'
        headers['Forwarded'] = 'host=airemoteview.buzz;proto=https'
        effective, client = Policy().proxy_context(headers, '127.0.0.1')
        self.assertEqual(effective, ('http', 'localhost', 18000))
        self.assertEqual(client, '127.0.0.1')
        effective, client = Policy(trusted_proxies=('127.0.0.1/32',)).proxy_context(headers, '127.0.0.1')
        self.assertEqual(effective, ('https', 'localhost', 18000))
        self.assertEqual(client, '198.51.100.1')
        self.assertEqual(Policy(trusted_proxies=('127.0.0.1/32',)).proxy_context(headers, '192.0.2.1')[0][0], 'http')

    def test_https_proxy_mode_secure_host_only_cookies_hsts_and_origin(self):
        self.start(Policy(trusted_hosts=('localhost', '127.0.0.1', 'airemoteview.buzz'), trusted_proxies=('127.0.0.1/32',),
                          public_origin='https://airemoteview.buzz', password=ENCODED, secure_cookies=True))
        headers = {'Host': 'airemoteview.buzz', 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '198.51.100.8'}
        self.assertEqual(self.request('/api/auth', headers={'Host': 'airemoteview.buzz'})[0], 403)
        response = self.login(headers)
        for key in ('__Host-rv_csrf', '__Host-rv_auth', '__Host-rv_owner'):
            self.assertIn(key, self.cookies)
        self.assertIn('Secure', response[1]['Set-Cookie'])
        self.assertIn('HttpOnly', response[1]['Set-Cookie'])
        self.assertIn('SameSite=Strict', response[1]['Set-Cookie'])
        self.assertNotIn('Domain=', response[1]['Set-Cookie'])
        self.assertEqual(response[1]['Strict-Transport-Security'], 'max-age=31536000')
        self.assertEqual(self.request('/api/sessions', {}, {**headers, 'Origin': 'https://airemoteview.buzz'})[0], 200)
        self.assertEqual(self.request('/api/sessions', {}, {**headers, 'Origin': 'http://airemoteview.buzz'})[0], 403)
        self.assertEqual(self.request('/api/auth', headers={**headers, 'X-Forwarded-Proto': 'https,http'})[0], 400)
        self.assertEqual(self.request('/api/auth', headers={**headers, 'CF-Connecting-IP': '198.51.100.8, 127.0.0.1'})[0], 400)
        self.assertEqual(self.request('/api/auth', headers={**headers, 'Host': 'evil.example', 'X-Forwarded-Host': 'airemoteview.buzz'})[0], 403)

    def test_host_validation_rejects_parser_aliases_and_duplicates(self):
        for host in ['evil.example', 'localhost.evil.example', 'localhost:bad', 'localhost@evil.example', 'localhost.', 'localhost/path', 'localhost:80:90', 'localhost%00']:
            self.assertIn(self.request('/api/auth', headers={'Host': host})[0], (400, 403), host)
        status, _ = self.raw_request(b'GET /api/auth HTTP/1.0\r\nHost: localhost\r\nHost: evil.example\r\n\r\n')
        self.assertEqual(status, 400)
        status, _ = self.raw_request(b'GET http://localhost/api/auth HTTP/1.0\r\nHost: localhost\r\n\r\n')
        self.assertEqual(status, 400)

    def test_framing_body_and_header_limits(self):
        self.request('/api/auth')
        self.assertEqual(self.request('/api/login', {'password': 'x' * 40001})[0], 413)
        self.assertEqual(self.request('/api/login', {}, {'Content-Type': 'text/plain'})[0], 415)
        for extra in [b'Content-Length: 2\r\nContent-Length: 2', b'Content-Length: -1', b'Content-Length: +2', b'Transfer-Encoding: chunked', b'Content-Encoding: gzip']:
            status, _ = self.raw_request(b'POST /api/login HTTP/1.0\r\nHost: localhost\r\n' + extra + b'\r\n\r\n{}')
            self.assertEqual(status, 400)
        status, _ = self.raw_request(b'GET /api/auth HTTP/1.0\r\nHost: localhost\r\nX-Large: ' + b'x' * 17000 + b'\r\n\r\n')
        self.assertEqual(status, 431)
        status, _ = self.raw_request(b'GET /api/auth HTTP/1.0\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}')
        self.assertEqual(status, 400)

    def test_health_is_minimal_and_independent_of_login_and_ollama(self):
        status, headers, body = self.request('/healthz')
        self.assertEqual((status, body), (200, {'status': 'ok'}))
        self.assertNotIn('Set-Cookie', headers)
        self.assertEqual(self.lab.db.execute('SELECT COUNT(*) FROM owners').fetchone()[0], 0)
        self.assertEqual(self.request('/healthz', method='HEAD')[2], b'')
        self.assertEqual(self.request('/healthz', headers={'Host': 'evil.example'})[0], 403)

    def test_security_headers_and_no_runtime_version_disclosure(self):
        for path in ['/', '/api/auth', '/missing']:
            status, headers, _ = self.request(path)
            self.assertEqual(headers['X-Frame-Options'], 'DENY')
            self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
            self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
            self.assertIn("form-action 'self'", headers['Content-Security-Policy'])
            self.assertIn("object-src 'none'", headers['Content-Security-Policy'])
            self.assertEqual(headers['Cache-Control'], 'no-store')
            self.assertNotIn('Python', headers['Server'])
            self.assertNotIn('Strict-Transport-Security', headers)
        self.assertEqual(self.request('/api/sessions', method='DELETE')[0], 405)

    def test_request_and_login_rate_limits_cannot_be_reset_by_new_cookie(self):
        self.start(Policy(password=ENCODED, rate_limit=4))
        for _ in range(4):
            self.assertEqual(self.request('/api/auth', use_cookies=False)[0], 200)
        status, headers, _ = self.request('/api/auth', use_cookies=False)
        self.assertEqual(status, 429)
        self.assertEqual(headers['Retry-After'], '60')
        self.start(Policy(password=ENCODED, login_limit=2))
        self.request('/api/auth')
        for _ in range(2):
            self.assertEqual(self.request('/api/login', {'password': 'wrong'})[0], 401)
        self.assertEqual(self.request('/api/login', {'password': PASSWORD})[0], 429)

    def test_inference_rate_and_concurrency_gates(self):
        self.start(Policy(password=ENCODED, inference_limit=1))
        self.login()
        session = self.request('/api/sessions', {})[2]
        route = '/api/sessions/' + session['id'] + '/guidance'
        with patch.object(self.lab, 'ollama', side_effect=OSError('offline')):
            self.assertEqual(self.request(route, {})[0], 200)
        self.assertEqual(self.request(route, {})[0], 429)
        self.start(Policy(password=ENCODED, max_inference=1))
        self.cookies = {}; self.login()
        session = self.request('/api/sessions', {})[2]
        self.lab.security.inference_slots.acquire()
        try:
            self.assertEqual(self.request('/api/sessions/' + session['id'] + '/guidance', {})[0], 429)
        finally:
            self.lab.security.inference_slots.release()

    def test_worker_capacity_is_bounded_and_recovers(self):
        self.start(Policy(max_workers=1))
        self.server.slots.acquire()
        try:
            self.assertEqual(self.request('/healthz')[0], 503)
        finally:
            self.server.slots.release()
        self.assertEqual(self.request('/healthz')[0], 200)

    def test_absolute_body_deadline_unblocks_incomplete_requests(self):
        self.start(Policy(request_timeout=1))
        self.request('/api/auth')
        cookie = '; '.join(f'{k}={v}' for k, v in self.cookies.items())
        wire = (f'POST /api/login HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nCookie: {cookie}\r\nX-CSRF-Token: {self.csrf}\r\nContent-Length: 20\r\n\r\n{{').encode()
        with socket.create_connection(('127.0.0.1', self.port), timeout=3) as connection:
            connection.sendall(wire)
            response = connection.recv(4096)
        self.assertIn(b'408', response.split(b'\r\n')[0])
        self.assertEqual(self.request('/healthz')[0], 200)

    def test_auth_persistence_password_rotation_and_local_revocation(self):
        from remoteview.sessions import revoke_all
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'test.sqlite3'
            original = Lab(db, '', 'test', Policy(password=ENCODED))
            owner, token = original.security.login(PASSWORD, '')
            session = original.act('POST', '/api/sessions', {}, owner)
            original.db.close()
            reopened = Lab(db, '', 'test', Policy(password=ENCODED))
            self.assertEqual(reopened.security.authenticated_owner(token), owner)
            reopened.db.close()
            changed = Lab(db, '', 'test', Policy(password=password_hash('a-new-test-only-password')))
            self.assertIsNone(changed.security.authenticated_owner(token))
            new_owner, token = changed.security.login('a-new-test-only-password', owner)
            self.assertEqual(changed.act('GET', '/api/sessions/' + session['id'], {}, new_owner)['id'], session['id'])
            changed.db.close()
            self.assertEqual(revoke_all(db), 1)
            reopened = Lab(db, '', 'test', Policy(password=password_hash('another-test-only-password')))
            self.assertIsNone(reopened.security.authenticated_owner(token))
            self.assertEqual(reopened.act('GET', '/api/sessions/' + session['id'], {}, new_owner)['id'], session['id'])
            reopened.db.close()
            with self.assertRaises(__import__('sqlite3').OperationalError):
                revoke_all(Path(folder) / 'does-not-exist.sqlite3')

    def test_limiter_memory_bound_fails_closed_and_recovers_on_expiry(self):
        clock = [0]
        limiter = RateLimiter(capacity=1, clock=lambda: clock[0])
        self.assertTrue(limiter.allow('one', 2))
        self.assertTrue(limiter.allow('one', 2))
        self.assertFalse(limiter.allow('one', 2))
        self.assertFalse(limiter.allow('new', 2))
        clock[0] = 61
        self.assertTrue(limiter.allow('new', 2))
