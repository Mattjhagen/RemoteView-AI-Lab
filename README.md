# RemoteView AI Lab

A local blinded observation practice app with Ollama guidance, installed-model discovery, persistent sessions, sealed transcripts, and target reveal. Python 3.12+; no packages to install.

## Run

Copy `.env.example` to `.env` if needed, then run:

```sh
python3 -m remoteview.app
```

Open http://127.0.0.1:8000. The application reads `OLLAMA_BASE_URL` and `OLLAMA_MODEL` from `.env`; process environment variables take precedence. No Ollama installation or server modification is performed. Model settings query `/api/tags` and choose among installed models only. Connection failures leave impression recording and finalization available, with a labeled offline guidance prompt.

## Session flow

1. Create a session. A random target is selected and stored only on the server.
2. Record impressions and optionally request neutral AI guidance.
3. Finalize the transcript. It becomes immutable and receives a timestamp and SHA-256 digest.
4. Explicitly reveal the target and download the record.

The server never includes target content, target codes, or session IDs in AI requests. Session access is scoped to a random HttpOnly, SameSite cookie. Targets are omitted from all session API responses until reveal. SQLite data stays in the ignored `data/` folder. Clearing browser cookies loses access to those sessions.

This baseline uses a small built-in pool of descriptive targets. It is a practice tool, not a scientific validation of remote viewing. The full master specification is now available. See docs/CONTINUATION.md for architecture gaps and the next implementation milestone.

The server binds to localhost. This is a local personal application, without multi-user authentication or public hosting support. Local administrators and processes with filesystem access can read the database and target pool. The configured Ollama endpoint uses the user's private network; the application sends recorded impressions to it when guidance is requested.

## Verify

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
```

## Session audit

Observations are preserved exactly as entered. New session actions record append-only audit events; GET `/api/sessions/{id}/audit` returns the current owner's event history. Finalization records the transcript digest. Existing sessions are preserved without fabricated historical events. SQLite triggers reject audit updates and deletes; filesystem administrators remain trusted. See docs/ENVIRONMENT.md for the R510 sandbox diagnosis.
