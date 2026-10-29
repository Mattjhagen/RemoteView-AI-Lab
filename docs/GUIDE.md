# Beginner guide

The in-site `/guide` page is static, works without JavaScript, and uses the existing dark palette. It contains no target answer, user data, external assets or inference requests. The header links to it from sign-in and judging too; contextual links open a separate tab to preserve unsaved work. Existing authentication and API boundaries remain in place.

Content follows `static/app.js`, `remoteview/research.py` and the inference payload boundary. Update the guide when conditions, scoring, response screening, image pool or dashboard behavior changes.

Validation: run `python3 -m unittest discover -s tests -v`, `node --check static/app.js`, and `npm run test:e2e`. Browser tests use disposable databases and mocked inference, including guide links, unsaved observation preservation, keyboard navigation, mobile widths, JavaScript-disabled rendering and the sign-in boundary.

For the existing production installation, review and run `./deploy.sh` from the checkout in an SSH terminal. It requests sudo, opens the production database read-only, creates a SQLite API backup, verifies integrity and exact experiment records, flushes the backup, and only then restarts `remoteview-ai.service` and checks health. A failure stops deployment. Never commit databases, backups, credentials or environment files.

After success, check `/guide` through the production HTTPS origin and verify private APIs still require admission. Commit only the reviewed source, guide, tests and documentation; push to the existing branch without force only after successful verification. Do not restore an old database for a guide rollback: revert the source change and use the verified deployment procedure.
