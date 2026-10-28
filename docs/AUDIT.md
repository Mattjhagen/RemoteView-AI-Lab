# Implementation audit — 2026-10-28

Audit scope: existing Python HTTP backend, SQLite database, static frontend, automated tests, Ollama discovery/inference, and the added experiments/judging/dashboard. Existing design and database rows were retained.

## Initial checks and fixes

| Requirement | Finding and resulting enforcement |
| --- | --- |
| Target withheld until finalization | Existing response allowlists already hid targets until explicit reveal. Retained. Pending human judgments now also block reveal, and experiment answers are withheld until ranking submission. Static file serving remains an explicit allowlist; source, database, and environment files are inaccessible through HTTP. |
| Observations immutable after finalization | Existing action guards passed. Added database triggers blocking finalized transcript/digest/timestamp changes and target reassignment. Observations retain whitespace and line breaks, and now receive recording timestamps. |
| AI monitor has no target information | Existing payload omission passed. Added a role/content-only inference boundary so timestamps/offline metadata from conversation entries cannot enter Ollama messages. Human and AI prompts never include target records, session codes, candidate mappings, or answer keys. Exact inference records make requests inspectable. |
| Cryptographically random target selection | Existing `secrets.choice` retained for human selection and extended to all experiment assignments. Candidate order uses `secrets.SystemRandom().shuffle`; trial/candidate/judging IDs use independent secure tokens. Model sampling seeds do not select targets. |
| Server-side transitions | Existing active → finalized → revealed guards retained. Added database transition guards and immutable completed/failed experiments and submitted judgments. Complete five-item permutation validation and one submission are enforced server-side. |
| Existing tests | All nine baseline tests passed before edits; they continue passing. Legacy SQLite upgrade/reopen retains observations, selected models, and existing audit history. No historical events are fabricated. |
| Ollama | `/api/tags` and `/api/chat` were verified against the environment-configured existing instance. Model discovery returned `qwen2.5-coder:3b`; inference returned a neutral question. No install, model change, or configuration change was made to Ollama. |

Additional fixes: owner cookies must reference a previously issued identity, guidance records are append-only, answer-free judging views use explicit field allowlists, and judge capabilities are redacted from logs and suppressed in referrers. Loading controls prevent repeated browser submissions. Transport errors and inference failures preserve observations; timed-out experiment requests direct the user to refresh history before retrying. Mobile comparison tables now scroll within their containers.

## Automated validation

- 22 Python tests: original functionality, legacy migrations, append-only audits, target and owner isolation, target-free human/AI payloads, selection order/timestamps across all three conditions, response hashes, installed-model validation, inference failure exclusion, exact observation preservation, complete immutable ranking, scoped image access, result persistence, dashboard denominators/grouping, and known Wilson interval values.
- Four Playwright tests in installed Chrome: full human guide/finalize/judge/reveal flow; AI conditions, model settings, judging, dashboard; loading/disconnect/retry; and mobile empty dashboard layout.
- JavaScript syntax checking and Python compilation.
- Live integration: real configured model discovery and neutral monitor inference, followed by before/after/control experiment runs using an isolated test database. Live checks never enter participant dashboard results.

## Threat boundary and limits

The protected boundary is the browser/API and the explicit outbound inference payload. The remote Ollama model receives no target data. This does not isolate a compromised Python process or filesystem administrator from the target database. Judging links authorize one assignment, not owner session/history access; they should be shared only with the intended judge. The app cannot enforce judge independence or stop a human from putting guesses into observations.

The five images are bundled original vector illustrations, not photographs. Repeated use, small samples, optional self-judging, and unadjusted comparisons limit interpretation. This release is not the full multi-service master-spec research platform. Independent target-vault credentials, authenticated judge roles, larger image pools, and durable experiment recovery remain future work.

Method references: [Ollama chat API and sampling options](https://github.com/ollama/ollama/blob/main/docs/api.md), [NIST Wilson score intervals for proportions](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm).
