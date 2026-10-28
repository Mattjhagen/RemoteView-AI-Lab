"""Experiment persistence, five-choice blind judging, and descriptive statistics."""
from datetime import datetime, timezone
import hashlib
import json
import math
import secrets

CONDITIONS = ('before', 'after', 'control')
EXPERIMENT_SYSTEM = 'You are a participant in a blinded observation exercise. No target information is available. Return only your own observations. Do not claim factual knowledge of any hidden target.'
EXPERIMENT_PROMPT = 'Record a short set of sensory impressions: shapes, textures, colors, movement, and spatial relationships. Avoid naming or guessing objects. Do not ask questions.'
CONTROL_PROMPT = 'Write a short description of an imagined scene using shapes, textures, colors, movement, and spatial relationships. Do not ask questions.'


def now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def stats(rows):
    n = len(rows)
    hits = sum(r['hit'] for r in rows)
    if not n:
        return {'n': 0, 'hits': 0, 'accuracy': None, 'ci95': None, 'baseline': .2}
    p, z = hits / n, 1.959963984540054
    center = (p + z*z/(2*n)) / (1 + z*z/n)
    margin = z * math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / (1 + z*z/n)
    return {'n': n, 'hits': hits, 'accuracy': p, 'ci95': [max(0, center-margin), min(1, center+margin)], 'baseline': .2}


class Research:
    def __init__(self, lab, targets):
        self.lab, self.targets = lab, targets
        lab.db.executescript('''
        CREATE TABLE IF NOT EXISTS experiments (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, condition TEXT NOT NULL,
          state TEXT NOT NULL, model TEXT NOT NULL, options TEXT NOT NULL,
          messages TEXT NOT NULL, response TEXT, response_hash TEXT,
          created_at TEXT NOT NULL, inference_started_at TEXT, inference_completed_at TEXT,
          target_selected_at TEXT, target TEXT, error TEXT, model_digest TEXT);
        CREATE TABLE IF NOT EXISTS judgments (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT UNIQUE,
          experiment_id TEXT UNIQUE, token TEXT NOT NULL UNIQUE,
          candidates TEXT NOT NULL, answer TEXT NOT NULL, ranking TEXT,
          created_at TEXT NOT NULL, submitted_at TEXT, hit INTEGER);
        CREATE TRIGGER IF NOT EXISTS sealed_judgment BEFORE UPDATE ON judgments
          WHEN OLD.submitted_at IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'Submitted rankings are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS judgment_no_delete BEFORE DELETE ON judgments
          BEGIN SELECT RAISE(ABORT, 'Judgments cannot be deleted'); END;
        CREATE TRIGGER IF NOT EXISTS experiment_no_delete BEFORE DELETE ON experiments
          BEGIN SELECT RAISE(ABORT, 'Experiments cannot be deleted'); END;
        CREATE TRIGGER IF NOT EXISTS experiment_output_locked BEFORE UPDATE ON experiments
          WHEN OLD.state IN ('completed','failed')
          BEGIN SELECT RAISE(ABORT, 'Completed experiments are immutable'); END;
        ''')
        # Owner credentials rotate on authentication. Sealed content stays immutable while
        # ownership associations can be transferred transactionally without rewriting results.
        for table, trigger, condition in (
            ('judgments', 'sealed_judgment', 'OLD.submitted_at IS NOT NULL'),
            ('experiments', 'experiment_output_locked', "OLD.state IN ('completed','failed')")):
            columns = [r[1] for r in lab.db.execute(f'PRAGMA table_info({table})') if r[1] != 'owner']
            changes = ' OR '.join(f'NEW."{column}" IS NOT OLD."{column}"' for column in columns)
            lab.db.execute(f'DROP TRIGGER IF EXISTS {trigger}')
            lab.db.execute(f"CREATE TRIGGER {trigger} BEFORE UPDATE ON {table} WHEN {condition} AND ({changes}) BEGIN SELECT RAISE(ABORT, 'Sealed record is immutable'); END")
        lab.db.commit()

    def experiment(self, eid, owner):
        row = self.lab.db.execute('SELECT * FROM experiments WHERE id=? AND owner=?', (eid, owner)).fetchone()
        if row is None:
            raise LookupError('Experiment not found')
        return row

    def public_experiment(self, row):
        # Explicit allowlist: no target, answer key, or selection timestamps before judging.
        result = {k: row[k] for k in ('id', 'condition', 'state', 'model', 'model_digest', 'created_at',
                    'inference_started_at', 'inference_completed_at', 'response', 'response_hash', 'error')}
        result['options'], result['messages'] = json.loads(row['options']), json.loads(row['messages'])
        judgment = self.lab.db.execute('SELECT * FROM judgments WHERE experiment_id=?', (row['id'],)).fetchone()
        if judgment:
            result['judging'] = self.assignment(judgment)
            if judgment['submitted_at']:
                result['target'] = json.loads(row['target'])
                result['target_selected_at'] = row['target_selected_at']
        return result

    def create_experiment(self, body, owner):
        condition = body.get('condition', 'before')
        if condition not in CONDITIONS:
            raise ValueError('Choose before, after, or control')
        temperature = body.get('temperature', .7)
        seed = body.get('seed', secrets.randbelow(2**31))
        if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not 0 <= temperature <= 2:
            raise ValueError('Temperature must be between 0 and 2')
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**31:
            raise ValueError('Seed must be an integer from 0 to 2147483647')
        options = {'temperature': temperature, 'seed': seed, 'num_predict': 300}
        with self.lab.lock:
            model = self.lab.db.execute('SELECT model FROM owners WHERE id=?', (owner,)).fetchone()[0]
        try:
            installed = self.lab.ollama('/api/tags')['models']
            metadata = next(m for m in installed if m['name'] == model)
        except (OSError, ValueError, KeyError, TypeError, StopIteration):
            raise ValueError('The selected Ollama model is unavailable. Refresh model settings and retry.')
        eid = secrets.token_urlsafe(24)
        messages = [{'role': 'system', 'content': EXPERIMENT_SYSTEM},
                    {'role': 'user', 'content': CONTROL_PROMPT if condition == 'control' else EXPERIMENT_PROMPT}]
        created = now()
        with self.lab.lock, self.lab.db:
            # Target choice and its timestamp are committed before inference begins.
            target = secrets.choice(self.targets) if condition == 'before' else None
            self.lab.db.execute('''INSERT INTO experiments
              (id,owner,condition,state,model,options,messages,created_at,target_selected_at,target,model_digest)
              VALUES(?,?,?,'running',?,?,?,?,?,?,?)''',
              (eid, owner, condition, model, json.dumps(options), json.dumps(messages), created,
               now() if target else None, json.dumps(target) if target else None, metadata.get('digest')))
            self.lab.audit(eid, 'experiment_created', {'condition': condition})
            self.lab.db.execute('UPDATE experiments SET inference_started_at=? WHERE id=?', (now(), eid))
        try:
            response, _ = self.lab.infer(model, messages, options)
        except (OSError, ValueError, KeyError, TypeError):
            with self.lab.lock, self.lab.db:
                self.lab.db.execute("UPDATE experiments SET state='failed', inference_completed_at=?, error=? WHERE id=?",
                                    (now(), 'Ollama inference failed. No result was scored. Start a new trial to retry.', eid))
                self.lab.audit(eid, 'inference_failed')
            with self.lab.lock:
                return self.public_experiment(self.experiment(eid, owner))
        completed = now()
        response_hash = digest(response)
        with self.lab.lock, self.lab.db:
            # After/control select an independent reference only after response bytes are sealed.
            selected_at = None
            if target is None:
                target, selected_at = secrets.choice(self.targets), now()
            self.lab.db.execute('''UPDATE experiments SET state='completed', response=?,response_hash=?,
                inference_completed_at=?,target=?,target_selected_at=COALESCE(target_selected_at,?) WHERE id=?''',
                (response, response_hash, completed, json.dumps(target), selected_at, eid))
            self.lab.audit(eid, 'inference_completed', {'response_hash': response_hash})
            self.make_judgment(owner, target, experiment_id=eid)
            return self.public_experiment(self.experiment(eid, owner))

    def make_judgment(self, owner, target, session_id=None, experiment_id=None):
        candidates = [{'id': secrets.token_urlsafe(18), 'image': t['title']} for t in self.targets]
        secrets.SystemRandom().shuffle(candidates)
        answer = next(c['id'] for c in candidates if c['image'] == target['title'])
        jid, token = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
        self.lab.db.execute('''INSERT INTO judgments
            (id,owner,session_id,experiment_id,token,candidates,answer,created_at) VALUES(?,?,?,?,?,?,?,?)''',
            (jid, owner, session_id, experiment_id, token, json.dumps(candidates), answer, now()))
        self.lab.audit(session_id or experiment_id, 'judging_started')
        return self.lab.db.execute('SELECT * FROM judgments WHERE id=?', (jid,)).fetchone()

    def assignment(self, row):
        return {'id': row['id'], 'token': row['token'], 'submitted_at': row['submitted_at'],
                'hit': row['hit'], 'url': '/?judge=' + row['token']}

    def start_session_judging(self, sid, owner):
        with self.lab.lock, self.lab.db:
            session = self.lab.session(sid, owner)
            existing = self.lab.db.execute('SELECT * FROM judgments WHERE session_id=?', (sid,)).fetchone()
            if existing:
                return self.assignment(existing)
            if session['state'] != 'finalized':
                raise ValueError('Only finalized, unrevealed sessions can enter blind judging')
            target = json.loads(session['target'])
            if target.get('title') not in [t['title'] for t in self.targets]:
                raise ValueError('This legacy target is not in the image pool')
            return self.assignment(self.make_judgment(owner, target, session_id=sid))

    def judge_row(self, token):
        row = self.lab.db.execute('SELECT * FROM judgments WHERE token=?', (token,)).fetchone()
        if row is None:
            raise LookupError('Judging assignment not found')
        return row

    def judge(self, token, ranking=None):
        with self.lab.lock, self.lab.db:
            row = self.judge_row(token)
            candidates = json.loads(row['candidates'])
            if ranking is not None:
                if row['submitted_at']:
                    raise ValueError('This ranking has already been submitted')
                if not isinstance(ranking, list) or len(ranking) != 5 or not all(isinstance(x, str) for x in ranking) or set(ranking) != {c['id'] for c in candidates}:
                    raise ValueError('Rank every candidate exactly once')
                self.lab.db.execute('UPDATE judgments SET ranking=?,submitted_at=?,hit=? WHERE id=?',
                    (json.dumps(ranking), now(), int(ranking[0] == row['answer']), row['id']))
                self.lab.audit(row['session_id'] or row['experiment_id'], 'ranking_submitted')
                row = self.judge_row(token)
            if row['session_id']:
                transcript = json.loads(self.lab.db.execute('SELECT transcript FROM sessions WHERE id=?', (row['session_id'],)).fetchone()[0])
                # Monitor questions are omitted so only participant observations inform ranking.
                observations = '\n\n'.join(t['content'] for t in transcript if t['role'] == 'user')
            else:
                observations = self.lab.db.execute('SELECT response FROM experiments WHERE id=?', (row['experiment_id'],)).fetchone()[0]
            result = {'id': row['id'], 'observations': observations, 'submitted_at': row['submitted_at'],
                      'candidates': [{'id': c['id'], 'image_url': f'/api/judge/{token}/images/{c["id"]}'} for c in candidates]}
            if row['submitted_at']:
                result.update(answer=row['answer'], ranking=json.loads(row['ranking']), hit=row['hit'])
            return result

    def pending_session(self, sid):
        return self.lab.db.execute('SELECT 1 FROM judgments WHERE session_id=? AND submitted_at IS NULL', (sid,)).fetchone() is not None

    def dashboard(self, owner):
        with self.lab.lock:
            rows = [dict(r) for r in self.lab.db.execute('''SELECT j.hit,j.submitted_at,j.id,
              j.session_id,j.experiment_id,e.condition,e.model FROM judgments j LEFT JOIN experiments e
              ON e.id=j.experiment_id WHERE j.owner=? AND j.submitted_at IS NOT NULL ORDER BY j.submitted_at''', (owner,))]
            for row in rows:
                row['kind'] = 'AI' if row['experiment_id'] else 'Human'
            groups = {}
            for key in ('kind', 'model', 'condition'):
                values = sorted({r[key] for r in rows if r[key] is not None})
                groups[key] = [{'label': value, **stats([r for r in rows if r[key] == value])} for value in values]
            counts = {r['state']: r['n'] for r in self.lab.db.execute('SELECT state,COUNT(*) n FROM experiments WHERE owner=? GROUP BY state', (owner,))}
            pending = self.lab.db.execute('SELECT COUNT(*) FROM judgments WHERE owner=? AND submitted_at IS NULL', (owner,)).fetchone()[0]
            return {'overall': stats(rows), 'groups': groups, 'history': rows, 'experiments': counts,
                    'pending_judgments': pending, 'interval_method': '95% Wilson score interval; descriptive, unadjusted for repeated comparisons'}
