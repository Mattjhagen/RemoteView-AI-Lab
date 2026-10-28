# RemoteView AI Lab

A local Python/SQLite lab with blinded human sessions, Ollama guidance, autonomous AI experiments, five-image blind judging, and a results dashboard. The existing interface and stored sessions are preserved. Python 3.12+; no runtime packages to install.

## Run

Copy `.env.example` to `.env` if needed, then:

```sh
python3 -m remoteview.app
```

The application binds to http://127.0.0.1:8000 by default (`PORT` can override it). Existing Mac access remains http://localhost:18000 through the SSH tunnel:

```sh
ssh -N -L 18000:127.0.0.1:8000 r510
```

`OLLAMA_BASE_URL` and `OLLAMA_MODEL` are read from `.env`; process environment takes precedence. Model settings discover installed models using `/api/tags`. Nothing installs Ollama, downloads models, or changes the existing Ollama server.

## Human sessions

1. Create a session. A cryptographically random target is assigned server-side.
2. Record observations exactly as entered. Ask for guidance to add a neutral monitor question to the conversation history. Only role/content messages enter inference; target data, target codes, IDs, and internal metadata are excluded.
3. Finalize. The transcript is permanently locked and receives a timestamp and SHA-256 digest. Database triggers reinforce application checks.
4. Optionally choose **Blind judge this session** before reveal. Share the generated link with an independent judge who can access the same local app/tunnel. Pending judging blocks answer reveal, even for the owner.
5. Submit all five ranks, reveal the target, and download the transcript. Revealed sessions cannot enter a new blind evaluation.

When Ollama is unavailable, human guidance uses a labeled offline prompt. Recording and finalization continue. Monitor request payloads, models, timestamps, response hashes, and fallback flags are persisted in `guidance_runs`; the owner can retrieve them at GET `/api/sessions/{id}/guidance`. Original observations are never rewritten by the model.

## AI experiments

**AI experiments** runs a one-shot autonomous participant using the selected installed model. Each trial records the model name/digest, exact prompts, temperature, sampling seed, token limit, UTC timestamps, response, and SHA-256 response hash.

- **Before:** target assignment is committed before the inference request starts.
- **After:** the response is obtained and hashed before the random target is selected.
- **Neutral control:** the model describes an imagined scene; an independent reference target is selected after inference. This is a prompt control, not a no-target scored condition.

Before/after use identical target-free prompts. No candidate images, target descriptions, target IDs, or condition labels are sent to the model. Seeds control model sampling, never target assignment. Failed inference is recorded as a failed trial and excluded from scored accuracy. Failed trials cannot be silently rerun or overwritten; start a new trial.

Every successful AI trial creates a blind judging assignment. Experiment history exposes the target and assignment timestamp only after ranking submission. The judge sees observations and five candidate images with opaque randomized IDs/order; participant type, condition, model, and answer are withheld in the judging view. A submitted ranking cannot be changed.

## Dashboard

The dashboard shows experiment counts, pending rankings, scored human versus AI results, model/condition comparisons, trial history, a cumulative accuracy chart, the 20% chance baseline, and 95% Wilson score intervals. Unsubmitted/failed trials do not enter accuracy denominators. Results are scoped to the owner cookie, including evaluations submitted by another browser using a judging link. [NIST describes the Wilson interval method](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm); these intervals are descriptive and unadjusted for repeated comparisons.

## Tests

Backend (22 tests; mocked inference, real HTTP boundaries):

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
```

Browser integration (4 tests; real application backend with deterministic Ollama responses, isolated in-memory database):

```sh
npm ci
npm run test:e2e
```

The browser suite uses installed Google Chrome at `/usr/bin/google-chrome`; set `CHROME_PATH` for another Chromium executable. It starts a disposable server at 127.0.0.1:18765 and never touches real sessions or the live Ollama server. Node dependencies are development-only. Live Ollama checks are recorded separately in [the audit](docs/AUDIT.md).

## Data, security, and limitations

SQLite and backups stay in ignored `data/`. Sessions use random HttpOnly, SameSite cookies. Clearing cookies loses the browser's access to existing records. Judging URLs are bearer capabilities: anyone with a link can view its sealed observations and submit one final ranking. Referrer headers are suppressed and capabilities are redacted from application logs. The application remains localhost-only; it has no public hosting or multi-user account/role support.

The image pool contains five bundled original vector landscape illustrations matching the existing descriptive targets. It is small and reusable, not a photographic research library. Self-judging is allowed; independent identity and independence of trials are not verified. Local administrators can inspect the database and target pool. Target omission is enforced at the inference payload boundary, but inference orchestration and target storage share a process/database; this is not a separate credential-isolated vault. Hashes detect changes against a recorded value, not malicious administrator tampering. A hard process interruption can leave a trial marked running; durable job recovery is a next milestone.

See [audit findings and verification](docs/AUDIT.md), [next milestones](docs/CONTINUATION.md), and [environment notes](docs/ENVIRONMENT.md). This is a practice/research prototype; its results do not establish paranormal ability.
