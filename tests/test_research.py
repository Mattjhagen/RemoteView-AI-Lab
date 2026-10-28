import hashlib
import json
import math
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

from remoteview.app import Lab, Handler, TARGETS
from remoteview.inference import payload
from remoteview.research import stats


class ResearchTests(unittest.TestCase):
    def setUp(self):
        self.lab = Lab(':memory:', 'http://unused.invalid', 'test-model')
        self.lab.owner('owner')
        self.lab.owner('other')
        self.lab.ollama = Mock(side_effect=self.model_response)

    def tearDown(self):
        self.lab.db.close()

    def model_response(self, path, body=None):
        if path == '/api/tags':
            return {'models': [{'name': 'test-model', 'digest': 'known-model-digest'}]}
        return {'message': {'content': 'A broad curved shape, cool and smooth.\nSlow movement.'}}

    def create(self, condition='before', **options):
        return self.lab.act('POST', '/api/experiments', {'condition': condition, **options}, 'owner')

    def judge(self, trial, correct=True):
        token = trial['judging']['token']
        private = self.lab.research.judge_row(token)
        view = self.lab.act('GET', '/api/judge/' + token, {}, 'other')
        ids = [c['id'] for c in view['candidates']]
        answer = private['answer']
        ids.remove(answer)
        ranking = [answer] + ids if correct else ids + [answer]
        return self.lab.act('POST', '/api/judge/' + token, {'ranking': ranking}, 'other')

    def human(self):
        session = self.lab.act('POST', '/api/sessions', {}, 'owner')
        path = '/api/sessions/' + session['id']
        self.lab.act('POST', path + '/impressions', {'text': '  Original\n spaced observations  '}, 'owner')
        self.lab.act('POST', path + '/finalize', {}, 'owner')
        assignment = self.lab.act('POST', path + '/judging', {}, 'owner')
        return session, path, assignment

    def test_conditions_selection_order_and_identical_blinded_experimental_prompts(self):
        prompts = []
        for condition in ('before', 'after', 'control'):
            def response(path, body=None):
                if path == '/api/tags':
                    return self.model_response(path)
                row = self.lab.db.execute('SELECT * FROM experiments ORDER BY rowid DESC LIMIT 1').fetchone()
                self.assertEqual(row['condition'], condition)
                self.assertEqual(row['state'], 'running')
                self.assertEqual(row['target'] is not None, condition == 'before')
                if condition == 'before':
                    self.assertLessEqual(row['target_selected_at'], row['inference_started_at'])
                self.assertEqual(set(body), {'model', 'messages', 'stream', 'options'})
                self.assertEqual(set(body['options']), {'temperature', 'seed', 'num_predict'})
                text = json.dumps(body)
                self.assertNotIn(row['id'], text)
                for target in TARGETS:
                    self.assertNotIn(target['title'], text)
                    self.assertNotIn(target['description'], text)
                self.assertNotIn('candidates', text)
                self.assertEqual(json.loads(row['messages']), body['messages'])
                prompts.append(body['messages'])
                return self.model_response(path, body)
            self.lab.ollama.side_effect = response
            trial = self.create(condition, temperature=.4, seed=42)
            self.assertEqual(trial['state'], 'completed')
            self.assertEqual(trial['model_digest'], 'known-model-digest')
            self.assertEqual(trial['options']['seed'], 42)
            self.assertEqual(trial['response_hash'], hashlib.sha256(trial['response'].encode()).hexdigest())
            private = self.lab.research.experiment(trial['id'], 'owner')
            if condition != 'before':
                self.assertGreaterEqual(private['target_selected_at'], private['inference_completed_at'])
            self.assertNotIn('target', trial)
            self.assertNotIn('target_selected_at', trial)
            self.assertNotIn('answer', json.dumps(trial))
            judged = self.judge(trial)
            self.assertEqual(judged['hit'], 1)
            revealed = self.lab.act('GET', '/api/experiments/' + trial['id'], {}, 'owner')
            self.assertIn('target_selected_at', revealed)
            self.assertIn('target', revealed)
        self.assertEqual(prompts[0], prompts[1])
        self.assertNotEqual(prompts[0], prompts[2])

    def test_installed_model_required_and_input_validation(self):
        for data in [{'condition': 'invalid'}, {'seed': -1}, {'seed': True}, {'seed': 2**31}, {'seed': 1.1},
                     {'temperature': -1}, {'temperature': 3}, {'temperature': True}, {'temperature': math.nan}, {'temperature': 'hot'}]:
            with self.assertRaises(ValueError):
                self.lab.act('POST', '/api/experiments', data, 'owner')
        self.lab.ollama = Mock(return_value={'models': []})
        with self.assertRaises(ValueError):
            self.create()
        self.assertEqual(self.lab.db.execute('SELECT COUNT(*) FROM experiments').fetchone()[0], 0)

    def test_inference_failure_is_recorded_and_not_scored(self):
        def fail(path, body=None):
            if path == '/api/tags':
                return self.model_response(path)
            raise TimeoutError('unavailable')
        self.lab.ollama.side_effect = fail
        trial = self.create('after')
        self.assertEqual(trial['state'], 'failed')
        self.assertIsNone(trial['response_hash'])
        self.assertIsNone(trial['response'])
        self.assertNotIn('judging', trial)
        self.assertIsNone(self.lab.research.experiment(trial['id'], 'owner')['target'])
        dashboard = self.lab.act('GET', '/api/dashboard', {}, 'owner')
        self.assertEqual(dashboard['overall']['n'], 0)
        self.assertEqual(dashboard['experiments']['failed'], 1)

    def test_blind_ranking_requires_full_permutation_and_is_final(self):
        trial = self.create()
        token = trial['judging']['token']
        route = '/api/judge/' + token
        view = self.lab.act('GET', route, {}, 'other')
        self.assertEqual(set(view), {'id', 'observations', 'submitted_at', 'candidates'})
        self.assertEqual(len(view['candidates']), 5)
        for candidate in view['candidates']:
            self.assertEqual(set(candidate), {'id', 'image_url'})
        ids = [c['id'] for c in view['candidates']]
        for ranking in ([], ids[:4], ids + ['foreign'], [ids[0]]*5, ids[:4] + ['foreign'], [None]*5, 'abcde', None):
            with self.assertRaises(ValueError):
                self.lab.act('POST', route, {'ranking': ranking}, 'other')
        judged = self.judge(trial, correct=False)
        self.assertEqual(judged['hit'], 0)
        self.assertIn('answer', judged)
        with self.assertRaises(ValueError):
            self.judge(trial)
        self.assertEqual(self.lab.act('GET', route, {}, 'other'), judged)
        with self.assertRaises(sqlite3.IntegrityError):
            self.lab.db.execute('UPDATE judgments SET hit=1')

    def test_human_judging_blocks_reveal_and_uses_original_observations(self):
        session, path, assignment = self.human()
        token = assignment['token']
        view = self.lab.act('GET', '/api/judge/' + token, {}, 'other')
        self.assertEqual(view['observations'], '  Original\n spaced observations  ')
        self.assertNotIn('answer', view)
        for action in ('reveal', 'impressions', 'guidance'):
            with self.assertRaises(ValueError):
                self.lab.act('POST', path + '/' + action, {'text': 'new'}, 'owner')
        self.assertNotIn('target', self.lab.act('GET', path, {}, 'owner'))
        self.assertEqual(assignment, self.lab.act('POST', path + '/judging', {}, 'owner'))
        self.judge({'judging': assignment})
        revealed = self.lab.act('POST', path + '/reveal', {}, 'owner')
        self.assertIn('target', revealed)
        self.assertEqual(revealed['transcript'][0]['content'], view['observations'])

    def test_active_and_already_revealed_sessions_cannot_be_blind_judged(self):
        s = self.lab.act('POST', '/api/sessions', {}, 'owner')
        path = '/api/sessions/' + s['id']
        with self.assertRaises(ValueError):
            self.lab.act('POST', path + '/judging', {}, 'owner')
        self.lab.act('POST', path + '/impressions', {'text': 'warm'}, 'owner')
        self.lab.act('POST', path + '/finalize', {}, 'owner')
        self.lab.act('POST', path + '/reveal', {}, 'owner')
        with self.assertRaises(ValueError):
            self.lab.act('POST', path + '/judging', {}, 'owner')

    def test_owner_isolation_and_capability_scope(self):
        trial = self.create()
        self.assertEqual(self.lab.act('GET', '/api/experiments', {}, 'other'), [])
        self.assertEqual(self.lab.act('GET', '/api/dashboard', {}, 'other')['overall']['n'], 0)
        with self.assertRaises(LookupError):
            self.lab.act('GET', '/api/experiments/' + trial['id'], {}, 'other')
        with self.assertRaises(LookupError):
            self.lab.act('GET', '/api/judge/invalid-token', {}, 'owner')
        self.judge(trial)
        self.assertEqual(self.lab.act('GET', '/api/dashboard', {}, 'other')['overall']['n'], 0)
        self.assertEqual(self.lab.act('GET', '/api/dashboard', {}, 'owner')['overall']['n'], 1)

    def test_database_enforces_locks_and_transitions(self):
        session, path, assignment = self.human()
        for sql in ["UPDATE sessions SET transcript='[]'", "UPDATE sessions SET digest='changed'",
                    "UPDATE sessions SET finalized_at='changed'", "UPDATE sessions SET state='active'",
                    "UPDATE sessions SET target='{}'"]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.lab.db.execute(sql)
        trial = self.create()
        with self.assertRaises(sqlite3.IntegrityError):
            self.lab.db.execute("UPDATE experiments SET response='changed'")

    def test_dashboard_accuracy_groups_pending_and_known_intervals(self):
        first, second, pending = self.create('before'), self.create('after'), self.create('control')
        self.judge(first)
        self.judge(second, False)
        _, _, human = self.human()
        self.judge({'judging': human}, False)
        data = self.lab.act('GET', '/api/dashboard', {}, 'owner')
        self.assertEqual(data['overall']['n'], 3)
        self.assertEqual(data['overall']['hits'], 1)
        self.assertAlmostEqual(data['overall']['accuracy'], 1/3)
        self.assertEqual(data['overall']['baseline'], .2)
        self.assertEqual(data['pending_judgments'], 1)
        self.assertEqual({r['label']: r['n'] for r in data['groups']['kind']}, {'AI': 2, 'Human': 1})
        self.assertEqual(data['groups']['model'][0]['n'], 2)
        self.assertEqual(len(data['history']), 3)
        self.assertNotIn('answer', json.dumps(data))
        self.assertIsNone(stats([])['ci95'])
        ci = stats([{'hit': 1}]*5 + [{'hit': 0}]*5)['ci95']
        self.assertAlmostEqual(ci[0], .23659309, places=7)
        self.assertAlmostEqual(ci[1], .76340691, places=7)
        self.assertAlmostEqual(stats([{'hit': 0}]*10)['ci95'][1], .2775328, places=7)
        self.assertAlmostEqual(stats([{'hit': 1}]*10)['ci95'][0], .7224672, places=7)

    def test_secure_randomness_and_no_stable_candidate_identifiers(self):
        with patch('remoteview.research.secrets.choice', wraps=__import__('secrets').choice) as choice, \
             patch('remoteview.research.secrets.SystemRandom', wraps=__import__('secrets').SystemRandom) as random:
            first = self.create()
            second = self.create()
            self.assertEqual(choice.call_count, 2)
            self.assertEqual(random.call_count, 2)
        one = self.lab.research.judge(first['judging']['token'])
        two = self.lab.research.judge(second['judging']['token'])
        self.assertTrue({c['id'] for c in one['candidates']}.isdisjoint({c['id'] for c in two['candidates']}))

    def test_inference_boundary_strips_metadata_and_records_guidance(self):
        cleaned = payload('test-model', [{'role': 'user', 'content': 'cool', 'target': 'SECRET', 'timestamp': 'private', 'offline': False}])
        self.assertEqual(cleaned['messages'], [{'role': 'user', 'content': 'cool'}])
        session = self.lab.act('POST', '/api/sessions', {}, 'owner')
        path = '/api/sessions/' + session['id']
        self.lab.act('POST', path + '/impressions', {'text': 'cool'}, 'owner')
        result = self.lab.act('POST', path + '/guidance', {}, 'owner')
        record = self.lab.db.execute('SELECT * FROM guidance_runs').fetchone()
        self.assertEqual(record['response_hash'], hashlib.sha256(result['transcript'][-1]['content'].encode()).hexdigest())
        request = json.loads(record['payload'])
        self.assertTrue(all(set(t) == {'role', 'content'} for t in request['messages']))
        self.assertNotIn(session['id'], record['payload'])
        self.assertLessEqual(record['started_at'], record['completed_at'])

    def test_completed_trials_survive_database_reopen(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'lab.db'
            original = Lab(db, 'http://unused.invalid', 'test-model')
            original.owner('owner')
            original.ollama = Mock(side_effect=self.model_response)
            trial = original.act('POST', '/api/experiments', {}, 'owner')
            original.db.close()
            reopened = Lab(db, 'http://unused.invalid', 'test-model')
            try:
                record = reopened.act('GET', '/api/experiments/' + trial['id'], {}, 'owner')
                self.assertEqual(record, trial)
            finally:
                reopened.db.close()

    def test_judging_images_http_access_control(self):
        trial = self.create()
        token = trial['judging']['token']
        view = self.lab.research.judge(token)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.lab = self.lab
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            for candidate in view['candidates']:
                with urllib.request.urlopen(base + candidate['image_url']) as response:
                    self.assertEqual(response.headers['Content-Type'], 'image/svg+xml')
                    image = response.read().decode()
                    self.assertIn('<svg', image)
                    self.assertNotIn('answer', image)
                    self.assertNotIn('<title', image)
            for path in [f'/api/judge/wrong/images/{view["candidates"][0]["id"]}', f'/api/judge/{token}/images/foreign', '/remoteview/app.py', '/data/lab.sqlite3', '/.env']:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(base + path)
                self.assertEqual(caught.exception.code, 404)
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(urllib.request.Request(base + '/', headers={'Host': 'evil.example'}))
            self.assertEqual(caught.exception.code, 403)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
