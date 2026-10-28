"""Generate a deployment password hash without putting plaintext into shell history."""
from getpass import getpass
from remoteview.security import password_hash


def main():
    password = getpass('New application password (at least 16 characters): ')
    if password != getpass('Confirm password: '):
        raise SystemExit('Passwords did not match')
    try:
        print('AUTH_PASSWORD_HASH=' + password_hash(password))
    except ValueError as error:
        raise SystemExit(str(error))


if __name__ == '__main__':
    main()
