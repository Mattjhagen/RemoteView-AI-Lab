"""Stdlib deployment policy, password sessions, proxy trust, and bounded throttling."""
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import hmac
import ipaddress
import os
import re
import secrets
import threading
import time
from urllib.parse import urlsplit


class Rejected(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def authority(value):
    if not value or re.search(r'[\s\\/@?#%]', value):
        raise ValueError('Invalid authority')
    parsed = urlsplit('//' + value)
    host, port = parsed.hostname, parsed.port
    if not host or parsed.path or parsed.username or parsed.password or value.endswith(':') or port == 0:
        raise ValueError('Invalid authority')
    if not re.fullmatch(r'[a-zA-Z0-9.-]+', host) or host.endswith('.'):
        raise ValueError('Invalid hostname')
    return host.lower(), port


def origin(value):
    if '?' in value or '#' in value:
        raise ValueError('Invalid origin')
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or parsed.path or parsed.query or parsed.fragment:
        raise ValueError('Invalid origin')
    host, port = authority(parsed.netloc)
    return parsed.scheme, host, port or (443 if parsed.scheme == 'https' else 80)


def password_hash(password):
    if not isinstance(password, str) or len(password) < 16 or len(password) > 1024:
        raise ValueError('Use a password of 16–1024 characters')
    salt = secrets.token_hex(16)
    key = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f'scrypt${salt}${key}'


def valid_hash(encoded):
    return bool(re.fullmatch(r'scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}', encoded))


def check_password(password, encoded):
    if not isinstance(password, str) or len(password) > 1024 or not valid_hash(encoded):
        return False
    _, salt, expected = encoded.split('$')
    key = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return hmac.compare_digest(key, expected)


@dataclass(frozen=True)
class Policy:
    trusted_hosts: tuple = ('127.0.0.1', 'localhost')
    trusted_proxies: tuple = ()
    public_origin: str = ''
    password: str = ''  # Encoded scrypt hash, never plaintext.
    secure_cookies: bool = False
    session_ttl: int = 43200
    max_body: int = 40000
    rate_limit: int = 120
    login_limit: int = 5
    inference_limit: int = 10
    max_workers: int = 24
    max_inference: int = 2
    request_timeout: int = 15

    def __post_init__(self):
        if not self.trusted_hosts or any(authority(h) != (h, None) for h in self.trusted_hosts):
            raise ValueError('TRUSTED_HOSTS must contain exact lower-case hostnames without ports')
        for network in self.trusted_proxies:
            ipaddress.ip_network(network, strict=True)
        if self.password and not valid_hash(self.password):
            raise ValueError('AUTH_PASSWORD_HASH must be generated with python3 -m remoteview.password')
        if self.public_origin:
            scheme, host, _ = origin(self.public_origin)
            if scheme != 'https' or host not in self.trusted_hosts or not self.password or not self.secure_cookies or not self.trusted_proxies:
                raise ValueError('PUBLIC_ORIGIN requires HTTPS, a trusted host, AUTH_PASSWORD_HASH, secure cookies, and explicit trusted proxies')
        if any(h not in ('127.0.0.1', 'localhost') for h in self.trusted_hosts) and not self.public_origin:
            raise ValueError('Non-local hosts require PUBLIC_ORIGIN and authenticated HTTPS deployment')
        for name in ('session_ttl', 'max_body', 'rate_limit', 'login_limit', 'inference_limit', 'max_workers', 'max_inference', 'request_timeout'):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f'{name} must be a positive integer')
        if self.max_body > 1048576 or self.max_workers > 128 or self.max_inference > 8 or self.session_ttl > 604800:
            raise ValueError('Configured security limits exceed supported bounds')

    @classmethod
    def from_env(cls):
        public = os.getenv('PUBLIC_ORIGIN', '')
        fields = {
            'trusted_hosts': tuple(s.strip() for s in os.getenv('TRUSTED_HOSTS', '127.0.0.1,localhost').split(',') if s.strip()),
            'trusted_proxies': tuple(s.strip() for s in os.getenv('TRUSTED_PROXIES', '').split(',') if s.strip()),
            'public_origin': public, 'password': os.getenv('AUTH_PASSWORD_HASH', ''),
            'secure_cookies': os.getenv('COOKIE_SECURE', 'true' if public else 'false').lower() == 'true'}
        for setting, name in [('AUTH_SESSION_TTL', 'session_ttl'), ('MAX_REQUEST_BYTES', 'max_body'), ('RATE_LIMIT_PER_MINUTE', 'rate_limit'),
                              ('LOGIN_LIMIT_PER_MINUTE', 'login_limit'), ('INFERENCE_LIMIT_PER_MINUTE', 'inference_limit'),
                              ('MAX_HTTP_WORKERS', 'max_workers'), ('MAX_CONCURRENT_INFERENCE', 'max_inference'), ('REQUEST_TIMEOUT', 'request_timeout')]:
            if setting in os.environ:
                fields[name] = int(os.environ[setting])
        return cls(**fields)

    def cookie_name(self, kind):
        return ('__Host-' if self.secure_cookies else '') + 'rv_' + kind

    def proxy_context(self, headers, peer):
        if len(headers.get_all('Host', [])) != 1:
            raise Rejected(400, 'Exactly one Host header is required')
        try:
            host, port = authority(headers['Host'])
        except ValueError:
            raise Rejected(400, 'Invalid Host header')
        if host not in self.trusted_hosts:
            raise Rejected(403, 'Untrusted host')
        trusted = any(ipaddress.ip_address(peer) in ipaddress.ip_network(n) for n in self.trusted_proxies)
        scheme, client = 'http', peer
        # Forwarded, X-Forwarded-Host/For, X-Real-IP, and Access identity headers are never authoritative.
        if trusted:
            if 'X-Forwarded-Proto' in headers:
                if len(headers.get_all('X-Forwarded-Proto')) != 1 or headers['X-Forwarded-Proto'] not in ('http', 'https'):
                    raise Rejected(400, 'Invalid forwarded protocol')
                scheme = headers['X-Forwarded-Proto']
            if 'CF-Connecting-IP' in headers:
                try:
                    if len(headers.get_all('CF-Connecting-IP')) != 1:
                        raise ValueError()
                    client = str(ipaddress.ip_address(headers['CF-Connecting-IP']))
                except ValueError:
                    raise Rejected(400, 'Invalid proxy client address')
        effective = (scheme, host, port or (443 if scheme == 'https' else 80))
        return effective, client


class RateLimiter:
    """Bounded fixed-window counters. New identities cannot evict active counters."""
    def __init__(self, capacity=10000, clock=time.monotonic):
        self.capacity, self.clock = capacity, clock
        self.entries = OrderedDict()
        self.lock = threading.Lock()

    def allow(self, key, limit, period=60):
        current = self.clock()
        with self.lock:
            for old in list(self.entries):
                if self.entries[old][0] <= current:
                    del self.entries[old]
            if key not in self.entries:
                if len(self.entries) >= self.capacity:
                    return False
                self.entries[key] = [current + period, 0]
            entry = self.entries[key]
            if entry[1] >= limit:
                return False
            entry[1] += 1
            return True


class Security:
    def __init__(self, lab, policy):
        self.lab, self.policy = lab, policy
        self.rates = RateLimiter()
        self.inference_slots = threading.BoundedSemaphore(policy.max_inference)
        with lab.lock, lab.db:
            lab.db.execute('''CREATE TABLE IF NOT EXISTS browser_auth (
              token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at REAL NOT NULL)''')
            lab.db.execute('CREATE TABLE IF NOT EXISTS authentication_config (id INTEGER PRIMARY KEY CHECK(id=1), password_marker TEXT NOT NULL)')
            marker = hashlib.sha256(policy.password.encode()).hexdigest()
            previous = lab.db.execute('SELECT password_marker FROM authentication_config WHERE id=1').fetchone()
            if previous is None or previous[0] != marker:
                lab.db.execute('DELETE FROM browser_auth')
                lab.db.execute('INSERT INTO authentication_config VALUES(1,?) ON CONFLICT(id) DO UPDATE SET password_marker=excluded.password_marker', (marker,))

    def authenticated_owner(self, token):
        if not re.fullmatch('[0-9a-f]{64}', token):
            return None
        with self.lab.lock:
            row = self.lab.db.execute('SELECT owner FROM browser_auth WHERE token_hash=? AND expires_at>?',
                                     (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return row['owner'] if row else None

    def login(self, password, previous_owner):
        if not self.policy.password or not check_password(password, self.policy.password):
            raise Rejected(401, 'Invalid credentials')
        new_owner, credential = secrets.token_hex(32), secrets.token_hex(32)
        with self.lab.lock, self.lab.db:
            # Rotate both credentials and retire the old identity, preserving exact record content.
            existing = self.lab.db.execute('SELECT 1 FROM owners WHERE id=?', (previous_owner,)).fetchone()
            if existing:
                self.lab.db.execute('UPDATE owners SET id=? WHERE id=?', (new_owner, previous_owner))
                for table in ('sessions', 'experiments', 'judgments'):
                    self.lab.db.execute(f'UPDATE {table} SET owner=? WHERE owner=?', (new_owner, previous_owner))
                self.lab.db.execute('DELETE FROM browser_auth WHERE owner=?', (previous_owner,))
            else:
                self.lab.db.execute('INSERT INTO owners VALUES (?,?)', (new_owner, self.lab.model))
            self.lab.db.execute('DELETE FROM browser_auth WHERE expires_at<=?', (time.time(),))
            self.lab.db.execute('INSERT INTO browser_auth VALUES(?,?,?)',
                (hashlib.sha256(credential.encode()).hexdigest(), new_owner, time.time() + self.policy.session_ttl))
        return new_owner, credential

    def logout(self, token):
        with self.lab.lock, self.lab.db:
            self.lab.db.execute('DELETE FROM browser_auth WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))
