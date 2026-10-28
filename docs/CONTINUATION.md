# Specification alignment and next milestones

This milestone extends the existing Python/SQLite and static HTML/JS application. It preserves its design, stored sessions, observation text, and audits. It does not migrate to FastAPI/PostgreSQL/Next.js or claim completion of the full master specification.

Implemented: secure random human target selection, target-free Ollama guidance, chronological conversation history, exact observations, database-enforced transcript sealing/state transitions, explicit reveal, inference metadata/hashes, three one-shot AI experiment conditions, five-image blind ranking with withheld answers, human/AI comparisons, model/condition results, cumulative accuracy chart, 20% baseline and 95% Wilson intervals. Both existing and new functionality have automated coverage; see [AUDIT.md](AUDIT.md).

Next milestones:

1. Expand the five illustrative stimuli into a licensed, diverse photographic pool with versioned manifests and candidate sampling rules. Preserve old trial stimuli and mappings.
2. Separate the target vault and inference worker into processes/services with restricted credentials and negative authorization tests. Current target omission is at the payload/API boundary, not process isolation.
3. Add authenticated participant/judge roles, independently assigned judges, experiment preregistration, and safeguards against repeated judging and optional stopping. Current bearer links permit self-judging and do not establish independence.
4. Add durable jobs with explicit interrupted-trial recovery. Current inference requests are bounded and failed responses are recorded, but a process crash can leave a running record.
5. Provide tested export/import and backup restoration before any future storage migration. Retain SQLite data, exact transcript bytes/hashes, and historical audit sequences.
6. Reconcile remaining master requirements, including voice, production deployment, and the proposed multi-service architecture, as separately scoped work while preserving the current UI.

## Access

The app continues to bind to 127.0.0.1:8000 unless `PORT` overrides it. Existing Mac access at http://localhost:18000 uses `ssh -N -L 18000:127.0.0.1:8000 r510`. No tunnel, firewall, Ollama, or unrelated service configuration is changed.

## Verification

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
npm ci
npm run test:e2e
```

The browser suite uses a disposable in-memory application database and deterministic Ollama responses. Real Ollama checks are separate and do not count as experimental results.

## Deployment preparation update

Authenticated HTTPS/proxy deployment controls, a health endpoint, resource limits and systemd/tunnel artifacts are now prepared. See [DEPLOYMENT.md](DEPLOYMENT.md) for the approval-gated cutover and [DEPLOYMENT_SECURITY.md](DEPLOYMENT_SECURITY.md) for findings and tests. No service or public route is activated by this milestone. The password gate does not implement the per-person participant/judge roles listed above.
