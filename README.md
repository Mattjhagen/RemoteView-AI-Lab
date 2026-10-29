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

Every valid AI trial creates a blind judging assignment. Empty, malformed, non-descriptive, and refusal/disclaimer responses are sealed as `invalid_response`, retain their complete response and hash, and receive no judging assignment or accuracy score. Request failures remain `failed`; no trial is silently retried. Validation is a conservative English-language heuristic, not a measure of correspondence or a guarantee of quality. Historical trials are not revalidated.

Expand **Experimental Instructions** to edit the target-free system and user prompts or restore defaults. Changing condition restores the corresponding defaults; the imagined-scene control remains distinct. Exact submitted instructions are saved per trial. Instructions are never populated from targets, candidates, or judging data. Experiment history exposes the target and assignment timestamp only after ranking submission. The judge sees observations and five candidate images with opaque randomized IDs/order; participant type, condition, model, and answer are withheld in the judging view. A submitted ranking cannot be changed.

## Dashboard

The dashboard shows experiment counts, pending rankings, scored human versus AI results, model/condition comparisons, trial history, a cumulative accuracy chart, the 20% chance baseline, and 95% Wilson score intervals. Unsubmitted/invalid/failed trials do not enter accuracy denominators. Results are scoped to the browser owner identity, including evaluations submitted by another browser using a judging link. [NIST describes the Wilson interval method](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm); these intervals are descriptive and unadjusted for repeated comparisons.

## Tests

Backend (47 tests; mocked inference, real HTTP boundaries):

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
```

Browser integration (9 tests; real application backend with deterministic Ollama responses, isolated in-memory database):

```sh
npm ci
npm run test:e2e
```

The browser suite uses installed Google Chrome at `/usr/bin/google-chrome`; set `CHROME_PATH` for another Chromium executable. It starts disposable servers at 127.0.0.1:18765 and :18766 and never touches real sessions or the live Ollama server. Node dependencies are development-only. Live Ollama checks are recorded separately in [the audit](docs/AUDIT.md).

## Data, security, and limitations

SQLite and backups stay in ignored `data/`. Sessions use random HttpOnly, SameSite cookies. Clearing cookies loses the browser's access to existing records. Judging URLs are bearer capabilities: a holder can view the assignment and submit one final ranking, with application login additionally required in authenticated deployments. Referrer headers are suppressed and capabilities are redacted from application logs. The origin remains bound to loopback. Authenticated HTTPS tunnel deployment is prepared below; per-person accounts and roles are not implemented.

The image pool contains five bundled original vector landscape illustrations matching the existing descriptive targets. It is small and reusable, not a photographic research library. Self-judging is allowed; independent identity and independence of trials are not verified. Local administrators can inspect the database and target pool. Target omission is enforced at the inference payload boundary, but inference orchestration and target storage share a process/database; this is not a separate credential-isolated vault. Hashes detect changes against a recorded value, not malicious administrator tampering. A hard process interruption can leave a trial marked running; durable job recovery is a next milestone.

See [audit findings and verification](docs/AUDIT.md), [next milestones](docs/CONTINUATION.md), and [environment notes](docs/ENVIRONMENT.md). This is a practice/research prototype; its results do not establish paranormal ability.

## Secure Cloudflare Tunnel deployment (prepared, not activated)

The production hostname is `airemoteview.buzz`. See [the complete deployment runbook](docs/DEPLOYMENT.md) and [security findings and verification](docs/DEPLOYMENT_SECURITY.md). No public route, DNS change, service installation, or existing tunnel edit is performed by this release.

The backend now supports a scrypt password gate, expiring/revocable authentication sessions, CSRF tokens, exact trusted hosts, explicit reverse-proxy trust, HTTPS host-only `__Host-` cookies, hardened headers, bounded workers/body reads, and rate/concurrency limits. `PUBLIC_ORIGIN` fails closed unless the complete authenticated HTTPS configuration is supplied. All session/target/judging boundaries remain in place, including after login credential rotation. Browser histories remain distinct; this shared password gate does not implement per-person accounts or roles. Cloudflare Access is recommended as an additional identity/MFA gate and must be configured to validate tokens at the connector.

Local HTTP/SSH development retains its anonymous browser-owner mode by default. To add local login, run `python3 -m remoteview.password`, store the returned `AUTH_PASSWORD_HASH` in a private `.env`, and restart the app. Keep `.env` mode 0600. Production uses the separate root-owned environment template and a dedicated service account; do not tunnel anonymous local mode.

Prepared artifacts:

- `deploy/remoteview-ai.service`: dedicated unprivileged user, fixed 127.0.0.1:8000 origin, restart/boot configuration, health probe, resource and filesystem restrictions.
- `deploy/remoteview-ai.env.example`: authenticated HTTPS/proxy configuration; intentionally blank password hash prevents deployment until configured.
- `deploy/cloudflared-remoteview.service.example` and `deploy/cloudflared-remoteview.yml.example`: dedicated connector alternatives, separate from existing production tunnels.

`GET /healthz` returns only `{"status":"ok"}` when the database responds; it requires a trusted host but no login and makes no Ollama request. It is suitable for local systemd/tunnel-origin checks. All data APIs, model settings, inference, judging views/images, and ranking submission require login when configured. POST clients must fetch `/api/auth`, retain its cookies, and send the returned `csrf_token` as `X-CSRF-Token`; this applies to CLI clients too. Login rotates credentials while preserving record content. Password changes revoke existing logins on restart; local emergency revocation is available through `python3 -m remoteview.sessions revoke-all`.

Current automated verification: **47 Python tests and nine browser integration tests**, covering the previous functionality plus login, expiry/logout, password rotation, owner migration/isolation, proxy spoofing, CSRF, request framing/size/deadline limits, throttling, worker bounds, HTTPS cookies, security headers, and multi-tab recovery. Google Chrome is used locally; no extra Ollama instance is installed.
