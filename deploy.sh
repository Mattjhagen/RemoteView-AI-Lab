#!/usr/bin/env bash
# Run manually from an SSH terminal. Never writes to the production database.
set -Eeuo pipefail
umask 077

stage='preflight'
trap 'code=$?; printf "Deployment FAILED during %s (exit %s).\n" "$stage" "$code" >&2; exit "$code"' ERR

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
service='remoteview-ai.service'
cd -- "$project_dir"

for command in sudo systemctl /usr/bin/python3 /usr/bin/curl; do
    command -v "$command" >/dev/null
done
if [[ "$(systemctl show "$service" --property=WorkingDirectory --value)" != "$project_dir" ||
      "$(systemctl show "$service" --property=User --value)" != 'remoteview-ai' ]]; then
    printf 'Deployment refused: service checkout or service user differs from the expected configuration.\n' >&2
    exit 1
fi

stage='sudo authentication'
# Password entry stays in the terminal; no password is read or stored by this script.
sudo -v

stage='database backup and verification'
sudo -u remoteview-ai /usr/bin/python3 - "$project_dir" <<'PY'
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from itertools import zip_longest
from pathlib import Path

root = Path(sys.argv[1]) / 'data'
source_path = root / 'lab.sqlite3'
if not source_path.is_file():
    raise SystemExit('Production database is missing; refusing deployment.')
folder = root / 'backups'
folder.mkdir(exist_ok=True, mode=0o700)
prefix = 'before-deploy-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-'
fd, filename = tempfile.mkstemp(prefix=prefix, suffix='.sqlite3', dir=folder)
os.close(fd)
backup_path = Path(filename)
print(f'Backup location: {backup_path}', flush=True)

# Read-only connection and a read transaction keep record comparison tied to
# the exact snapshot copied by SQLite, even while the application is active.
source = sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True, timeout=30)
try:
    source.execute('BEGIN')
    count = source.execute('SELECT COUNT(*) FROM experiments').fetchone()[0]
    with sqlite3.connect(backup_path) as destination:
        source.backup(destination)
    with sqlite3.connect(backup_path.as_uri() + '?mode=ro', uri=True) as check:
        if check.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise RuntimeError('Backup integrity verification failed; service will not restart.')
        if check.execute('SELECT COUNT(*) FROM experiments').fetchone()[0] != count:
            raise RuntimeError('Experiment count mismatch; service will not restart.')
        missing = object()
        original = source.execute('SELECT * FROM experiments ORDER BY id')
        copied = check.execute('SELECT * FROM experiments ORDER BY id')
        if any(a != b for a, b in zip_longest(original, copied, fillvalue=missing)):
            raise RuntimeError('Experiment records differ; service will not restart.')
    # Ensure the verified backup has been flushed before allowing the restart.
    with backup_path.open('rb') as backup_file:
        os.fsync(backup_file.fileno())
    print(f'Backup verified: integrity OK; all {count} experiment records preserved.', flush=True)
finally:
    source.close()
PY

stage='service restart'
sudo systemctl restart "$service"

stage='service verification'
systemctl is-active --quiet "$service"
printf 'Service active: %s\n' "$service"
/usr/bin/curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 --max-time 5 http://127.0.0.1:8000/healthz
printf '\nDeployment SUCCESS: verified backup created; service restarted and responding.\n'
