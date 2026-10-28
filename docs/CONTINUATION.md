# Specification alignment and next milestone

The full specification supplied in the user's shared terminal is now available for planning. The current implementation is a local personal Python stdlib/SQLite app with static HTML/JS. It is not the requested FastAPI/PostgreSQL/Next.js architecture and must not be described as a completed research platform.

Completed baseline: cookie-scoped sessions, random selection from five built-in descriptive practice targets, Ollama model discovery/selection, neutral guidance with offline fallback, transcript finalization/hash, explicit reveal. Follow-up adds exact observation preservation and transactionally recorded session audit events, with SQLite triggers rejecting updates/deletes. GET /api/sessions/{id}/audit returns only the current owner's event history without target answers. Existing rows receive no invented historical events. New events begin when updated code runs.

Audit triggers protect ordinary application writes, not a filesystem administrator. Target data remains in the same process/database as inference orchestration. Payload omission tests do not establish service or credential isolation. No image target library, multi-user accounts/roles, AI-only conditions, blind ranking, scientific scoring, analytics, voice, or production deployment has been completed.

Next implementation milestone:

1. Preserve existing SQLite sessions and create a tested import path before changing storage.
2. Establish project-local FastAPI/Pydantic/SQLAlchemy/Alembic and Next.js/TypeScript/Tailwind structure. Keep localhost defaults; avoid occupied ports.
3. Implement a target-vault API and separate inference worker with restricted credentials and negative authorization tests; never ship shared vault credentials to inference.
4. Add PostgreSQL configuration and migrations. Discover existing server availability first; request approval before changing system services or databases outside this project.
5. Add CREATED/ACTIVE/FINALIZED/REVEALED/SCORED transitions, password authentication and roles before adding judging or broader access.
6. Continue with image import, one-shot AI experiments, five-choice judging, appropriate statistics, voice and native deployment documents. Track remaining master requirements explicitly.

## Native startup and access

Run `cd /home/matt/RemoteView-AI-Lab && python3 -m remoteview.app` after stopping the existing project process in its original Codex terminal. Do not kill unrelated Python processes. Existing service on port 8000 is deliberately left alone by this milestone.

From the Mac, use `ssh -N -L 18000:127.0.0.1:8000 r510`, then visit http://127.0.0.1:18000. This forwards access without firewall or reverse-proxy changes. Keep the tunnel open while using the app.

## Verification

`python3 -m unittest discover -s tests -v`

`node --check static/app.js`

The live Ollama model listing was verified separately; automated guidance tests use mocks and do not establish paranormal ability or experimental results.
