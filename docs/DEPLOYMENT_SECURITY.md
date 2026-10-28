# Deployment security review — 2026-10-28

## Scope and result

Reviewed the existing Python 3.12/SQLite/static JavaScript application and its HTTP, session, inference, judging, configuration, and startup boundaries. Preserved the architecture, stored observations, transcript/target protections, image judging and dashboard. Preparation does not publish the app or change existing systemd/tunnel configurations.

An independent source auditor reviewed authentication/authorization and compatibility; a separate architecture reviewer mapped data and trust boundaries. A fresh patch reviewer examined bypass/regression paths. Source findings were validated against the code and focused HTTP/browser tests. The optional Codex Security workbench export could not save its canonical report because an ancestor of its managed output directory is group/world-writable without the sticky bit. Its scan remains unsealed; no workbench completion is claimed. Unrelated home/Codex permissions were not altered. This user-requested repository document records the audit, fixes, verification, and remaining deployment gates.

## Findings and fixes

Severity below assumes the proposed future tunnel is reachable; the original app was loopback-only and no new public exposure was observed or created.

| Finding | Original behavior / impact | Resolution |
| --- | --- | --- |
| High: no admission authentication (CWE-306) | Every allowed caller automatically received a new owner credential and could persist records or invoke shared Ollama resources. Ownership partitioned data but did not authorize app entry. | Public-origin startup requires a valid salted scrypt password hash and HTTPS policy. All data/settings/inference/judging APIs and images require an unexpired server-side auth session. The static login shell/auth bootstrap and minimal health are the intended exceptions. Fake Cloudflare identity headers grant no authority. |
| Medium: bearer cookies not HTTPS-safe (CWE-614) | Sole owner cookie had HttpOnly/SameSite but no Secure or expiry/login lifecycle. | Production uses Secure, HttpOnly, SameSite=Strict, host-only `__Host-` cookies. Authentication tokens are hashed in SQLite, expire after 12 hours by default, rotate on successful login, and are revoked at logout or password change. Owner credentials also rotate; record associations transfer without altering sealed content. Same-host legacy cookies upgrade only after a successful password challenge; retired owner credentials no longer work. |
| Medium: unbounded resource use (CWE-400) | Thread-per-request server, no absolute body deadline, no rate/inference concurrency controls. | Workers bounded before allocation; socket plus absolute request-read deadlines; bounded headers/URL/body and strict framing; fixed-window client and owner limits; global password-hashing budget and inference semaphore. Full counters fail closed instead of evicting active keys. |
| Deployment gap: weak origin/authority parsing | Host split at first colon; supplied Origin compared only by netloc; no explicit proxy policy. Existing JSON-only/SameSite checks provided local browser defenses. | Parse exact hosts/ports, reject duplicate/malformed Host, require CSRF token on every POST including login/logout, compare full origin including scheme, enforce Fetch Metadata, reject duplicate framing/encoded bodies. Trust only X-Forwarded-Proto and CF-Connecting-IP from explicitly configured proxy networks; ignore forwarded host/chain/Access identity headers. |
| Compatibility regressions caught by review | Renaming secure cookies could strand same-host history; another tab's login/logout could stale CSRF indefinitely. | Focused secure-cookie migration test confirms sealed transcripts, completed experiments, and submitted judgments survive credential rotation exactly. Browser retries only an explicit pre-mutation CSRF rejection once after bootstrap refresh. Multi-tab regression test passes. |

No cross-owner session disclosure, target leak in inference, pre-submit answer-key disclosure, arbitrary static-file access, SQL injection, or DOM rendering injection was found in the reviewed paths. This is a source/test conclusion, not proof against every possible vulnerability. There is no web administration or account-role API. Password-hash generation and emergency auth revocation are local CLI operations requiring host file permissions.

## Preserved target and integrity boundaries

- Server target assignment remains cryptographically random; inference sampling seeds cannot choose targets.
- Responses use explicit allowlists. Human targets require finalization and reveal; pending judging blocks reveal; autonomous answers remain hidden until ranking submission.
- Inference accepts only model, options, and role/content messages. No target, candidate mapping, target code, owner identity, or trial ID is supplied to the model.
- Session/experiment/dashboard queries retain owner predicates. A judge requires app admission plus a per-assignment capability and gets no owner history.
- Database triggers preserve finalized transcript bytes/digest/timestamps, immutable targets, audit/guidance append-only records, completed experiment content, and submitted judgment content. Sealed-result triggers permit only owner metadata transfer during credential rotation; result fields remain locked.
- Stored trials and audits are not rewritten to invent historical security events. Authentication tables are additive. Normal schema startup preserves existing sessions. A consistent pre-upgrade backup was taken and every existing owner/session/trial/judgment/guidance/audit row compared equal after the local upgrade.

## Enforcement details

`remoteview/security.py` owns deployment policy, scrypt verification, auth sessions and throttling; `remoteview/app.py` enforces HTTP boundaries before dispatch; `remoteview/research.py` retains target/judging state guards. Frontend login/CSRF support extends the existing UI rather than replacing it.

| Setting/control | Default / behavior |
| --- | --- |
| Local trusted hosts | `127.0.0.1,localhost`; no implicit reverse-proxy trust. |
| Production origin | Explicit `PUBLIC_ORIGIN=https://airemoteview.buzz`; mandatory password, trusted host/proxy and secure cookies. The service forces production configuration. |
| Trusted connector | Explicit `TRUSTED_PROXIES=127.0.0.1/32`; other source addresses' forwarded values are ignored. Header chains, forwarded Host and identity assertions are never used for authorization. |
| Auth expiry | `AUTH_SESSION_TTL=43200`, absolute, maximum seven days. No sliding extension. Server restart retains unexpired sessions with the same hash; password changes invalidate them. |
| Cookie protection | Secure production prefix, HttpOnly, Strict, Path=/, no Domain. Auth Max-Age is bounded by server-side expiry. CSRF rotates on login/logout. |
| Read limits | 16 KiB headers, 4 KiB URL, 40000-byte body, 15-second absolute read deadline. Duplicate lengths, transfer/content encoding, GET bodies, and malformed JSON fail closed. |
| Rate limits | 120 requests/client/minute, five logins/client/minute, global 30 login attempts/minute, ten inference requests/client and owner/minute. New cookies cannot reset client counters. |
| Concurrency | 24 HTTP workers, two inference slots; overload returns 503/429 and Retry-After. Rate counters have a bounded in-memory map and reset on process restart. |
| Response headers | no-store, nosniff, no-referrer, DENY framing, restrictive CSP including form-action/object-src, disabled camera/mic/geolocation; HSTS only with trusted HTTPS context. Runtime version and sensitive errors are suppressed. |
| Health | Trusted-host GET/HEAD `/healthz`; minimal database-readiness response; no cookies, private metadata or Ollama call. |

Local processes on the trusted loopback interface can simulate forwarding headers; trusted local administrators/processes remain a deployment assumption. This app does not cryptographically authenticate its proxy connection. It does not validate Cloudflare Access JWTs itself; the dedicated connector must perform that check in addition to the app's password gate. Existing unrelated connectors are not implicitly trusted by identity. Never allow broad proxy networks or bypass Access on API/health/image paths.

## Verification

Commands:

```sh
python3 -m unittest discover -s tests -v
node --check static/app.js
python3 -m compileall -q remoteview tests
npm run test:e2e
systemd-analyze verify deploy/remoteview-ai.service
cloudflared tunnel --config deploy/cloudflared-remoteview.yml.example ingress validate
```

The full suite contains 44 backend tests (the original 22 plus 22 security tests) and seven Playwright flows (the original four plus three authentication/multi-tab flows). Tests use isolated temporary/in-memory databases; browser mock login limits are raised only in the test fixture to avoid cross-test interference. Production/default rate controls are independently tested. Security reproductions exercise the real HTTP boundary: anonymous data access now returns 401, forged headers/owner credentials cannot authenticate, bad/missing CSRF returns 403, oversize/framing errors are rejected, slow bodies time out, expired/revoked tokens fail, and overloaded resources return controlled errors. Legitimate local, authenticated HTTPS-proxy simulation, history, inference fallback, blind ranking, and transcript finalization remain functional.

The app unit passes systemd's static verification. The inert locally managed tunnel template passes the installed cloudflared ingress validator. These are configuration checks, not proof of a live systemd sandbox or Cloudflare Access deployment. No test enables DNS/public routing or installs services. The existing Ollama endpoint/model remain unchanged; live discovery and guidance inference also passed using an isolated in-memory database, without affecting trial results.

## Remaining deployment gates and limitations

The operator still must choose a real application password, create dedicated service identities/permissions, install and enable the prepared unit during an approved port-8000 cutover, configure Access with an explicit allow policy and connector JWT validation, and approve a new dedicated tunnel/hostname. End-to-end public TLS, Access identity/MFA, deployed cookie handling, service restart/reboot, and actual systemd sandbox behavior are **not validated** by static templates or local simulated-proxy tests. Follow [DEPLOYMENT.md](DEPLOYMENT.md) in order; public routing is the final unperformed step.

The shared password is not individual accounts; private browser histories are partitioned by separate owner credentials. Moving from localhost to a different domain does not transfer browser cookies; retain exports before cutover. Targets/inference orchestration still share a process/database. Five illustrative stimuli, optional self-judging and crash-interrupted running experiments remain the existing research limitations. The standard-library HTTP server is bounded and hardened here, but still requires the intended private origin, Cloudflare protections and monitoring.
