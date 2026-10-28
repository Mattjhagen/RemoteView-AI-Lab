import hashlib
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import Mock

from remoteview.app import Handler, Lab


class LabTests(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(':memory:', 'http://unused.invalid', 'configured-model')
        self.lab.owner('alice')
        self.lab.owner('bob')
        self.session = self.lab.act('POST', '/api/sessions', {}, 'alice')
        self.path = '/api/sessions/' + self.session['id']

    def tearDown(self):
        self.lab.db.close()

    def act(self, action, body=None):
        return self.lab.act('POST', self.path + '/' + action, body or {}, 'alice')

    def test_complete_session_and_immutable_transcript(self):
        self.assertNotIn('target', self.session)
        with self.assertRaises(ValueError):
            self.act('reveal')
        with self.assertRaises(ValueError):
            self.act('finalize')
        observed = self.act('impressions', {'text': 'Cool, flowing, broad vertical shapes'})
        sealed = self.act('finalize')
        self.assertEqual(sealed['state'], 'finalized')
        self.assertNotIn('target', sealed)
        self.assertTrue(sealed['finalized_at'])
        expected = hashlib.sha256(json.dumps(observed['transcript']).encode()).hexdigest()
        self.assertEqual(sealed['digest'], expected)
        for action in ('impressions', 'guidance', 'finalize'):
            with self.assertRaises(ValueError):
                self.act(action, {'text': 'changed'})
        revealed = self.act('reveal')
        self.assertIn('target', revealed)
        self.assertEqual(revealed['transcript'], sealed['transcript'])
        self.assertEqual(revealed, self.act('reveal'))

    def test_owner_isolation_including_reveal(self):
        self.assertEqual(self.lab.act('GET', '/api/sessions', {}, 'bob'), [])
        for method, suffix in [('GET', ''), ('POST', '/reveal'), ('POST', '/impressions')]:
            with self.assertRaises(LookupError):
                self.lab.act(method, self.path + suffix, {'text': 'guess'}, 'bob')

    def test_guidance_payload_has_no_target_data(self):
        self.act('impressions', {'text': 'Rough and cool'})
        self.lab.ollama = Mock(return_value={'message': {'content': 'What texture stands out?'}})
        result = self.act('guidance')
        path, payload = self.lab.ollama.call_args.args
        self.assertEqual(path, '/api/chat')
        self.assertEqual(set(payload), {'model', 'messages', 'stream'})
        self.assertEqual(payload['model'], 'configured-model')
        self.assertEqual(payload['messages'][1], {'role': 'user', 'content': 'Rough and cool'})
        self.assertNotIn(self.session['id'], json.dumps(payload))
        self.assertNotIn(self.session['code'], json.dumps(payload))
        self.assertFalse(result['transcript'][-1]['offline'])

    def test_disconnect_fallback_and_model_discovery(self):
        self.lab.ollama = Mock(side_effect=OSError('offline'))
        self.assertFalse(self.lab.models()['connected'])
        result = self.act('guidance')
        self.assertTrue(result['transcript'][-1]['offline'])
        self.act('impressions', {'text': 'Still able to record'})
        self.assertEqual(self.act('finalize')['state'], 'finalized')
        self.lab.ollama = Mock(return_value={'models': [{'name': 'second'}, {'name': 'first'}]})
        settings = self.lab.act('POST', '/api/settings', {'model': 'second'}, 'alice')
        self.assertEqual(settings['models'], ['first', 'second'])
        self.assertEqual(settings['selected_model'], 'second')
        self.assertEqual(self.lab.act('GET', '/api/settings', {}, 'bob')['selected_model'], 'configured-model')
        with self.assertRaises(ValueError):
            self.lab.act('POST', '/api/settings', {'model': 'not-installed'}, 'alice')

    def test_guidance_cannot_change_finalized_transcript(self):
        self.act('impressions', {'text': 'soft'})
        def finalize_during_request(*args):
            self.act('finalize')
            return {'message': {'content': 'Late guidance'}}
        self.lab.ollama = Mock(side_effect=finalize_during_request)
        with self.assertRaises(ValueError):
            self.act('guidance')
        record = self.lab.act('GET', self.path, {}, 'alice')
        self.assertEqual(len(record['transcript']), 1)
        self.assertEqual(record['state'], 'finalized')

    def test_http_boundaries(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.lab = self.lab
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            request = urllib.request.Request(base + '/api/sessions', data=b'{}', headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request) as response:
                cookie = response.headers['Set-Cookie']
                self.assertIn('HttpOnly', cookie)
                self.assertIn('SameSite=Strict', cookie)
                session = json.load(response)
            with urllib.request.urlopen(base + '/api/sessions/' + session['id']) as response:
                self.fail('Another browser should not see this session')
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 404)
        finally:
            for headers, expected in [({'Content-Type': 'text/plain'}, 415), ({'Content-Type': 'application/json', 'Origin': 'http://evil.example'}, 403)]:
                request = urllib.request.Request(base + '/api/sessions', data=b'{}', headers=headers)
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(request)
                self.assertEqual(caught.exception.code, expected)
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
