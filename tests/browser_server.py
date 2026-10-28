"""Disposable deterministic backend for browser integration tests. Never uses user data."""
import sys
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from remoteview.app import Lab, Handler
from remoteview.security import Policy, password_hash

auth_mode = '--auth' in sys.argv
policy = Policy(password=password_hash('browser-test-only-password') if auth_mode else '', login_limit=100, rate_limit=1000)
lab = Lab(':memory:', 'http://unused.invalid', 'browser-test-model', policy)

def ollama(path, payload=None):
    if path == '/api/tags':
        return {'models': [{'name': 'browser-test-model', 'digest': 'browser-model-digest'}, {'name': 'second-model', 'digest': 'second-digest'}]}
    return {'message': {'content': 'What else, if anything, do you notice?' if 'options' not in payload else 'Cool smooth curves and a broad horizontal shape.'}}
lab.ollama = ollama
class BrowserHandler(Handler):
    def log_request(self, code='-', size='-'):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 18766 if auth_mode else 18765), BrowserHandler)
server.lab = lab
print('Browser test server ready', flush=True)
server.serve_forever()
