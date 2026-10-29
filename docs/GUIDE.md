# Beginner guide

The in-site `/guide` page is static, works without JavaScript, and uses the existing dark palette. It contains no target answer, user data, external assets or inference requests. The header links to it from sign-in and judging too; contextual links open a separate tab to preserve unsaved work. Existing authentication and API boundaries remain in place.

Content follows `static/app.js`, `remoteview/research.py` and the inference payload boundary. Update the guide when conditions, scoring, response screening, image pool or dashboard behavior changes.

Validation: run `python3 -m unittest discover -s tests -v`, `node --check static/app.js`, and `npm run test:e2e`. Browser tests use disposable databases and mocked inference, including guide links, unsaved observation preservation, keyboard navigation, mobile widths, JavaScript-disabled rendering and the sign-in boundary.

For the existing production installation, review and run `./deploy.sh` from the checkout in an SSH terminal. It requests sudo, opens the production database read-only, creates a SQLite API backup, verifies integrity and exact experiment records, flushes the backup, and only then restarts `remoteview-ai.service` and checks health. A failure stops deployment. Never commit databases, backups, credentials or environment files.

After success, check `/guide` through the production HTTPS origin and verify private APIs still require admission. Commit only the reviewed source, guide, tests and documentation; push to the existing branch without force only after successful verification. Do not restore an old database for a guide rollback: revert the source change and use the verified deployment procedure.

## Beginner interface

The homepage now explains hidden scenes and offers a direct human-session start or AI alternative. Human sessions use Write → Lock → Compare → Reveal, with contextual next-step instructions, explicit save feedback, optional help and clear consequences for a reflection-only reveal. Pending comparison links survive reopening a session. Session responses include only owner-scoped assignment metadata; the answer stays hidden until ranking submission.

Draft observations stay in tab memory while switching sessions or modes and through optional AI guidance. They are not saved until Save observation is pressed and are not stored in localStorage. Leaving with unsaved notes prompts the browser; signing out or losing authentication clears private drafts and interface content.

AI settings explain trial types inline and tuck temperature, seed and instruction editing into expandable sections. An unavailable model disables AI runs but leaves human sessions available. Judging explains first versus fifth place and reports duplicate ranks as choices are made. The dashboard explains its counts and provides a useful empty state. The full guide uses the same action labels as the interface.

The browser suite additionally covers the complete beginner scored flow, reopening a pending ranking, reflection-only confirmation and cancellation, draft preservation, model unavailability, and layout at 360, 390, 768 and 1280 pixels. Backend coverage checks owner isolation and that session-progress metadata exposes no hidden answer.
