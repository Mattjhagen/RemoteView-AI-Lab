"""Local-only authentication revocation; no web administration endpoint."""
import argparse
import sqlite3
from pathlib import Path


def revoke_all(database):
    with sqlite3.connect(Path(database).resolve().as_uri() + '?mode=rw', uri=True, timeout=10) as connection:
        return connection.execute('DELETE FROM browser_auth').rowcount


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['revoke-all'])
    parser.parse_args()
    database = Path(__file__).resolve().parent.parent / 'data' / 'lab.sqlite3'
    # Do not silently create a database if the operator is in the wrong checkout.
    count = revoke_all(database)
    print(f'Revoked {count} authentication session(s). Stored trials were preserved.')


if __name__ == '__main__':
    main()
