"""Set/reset the one administrator from a trusted server terminal."""

from getpass import getpass

from wildstring.auth import Auth
from wildstring.config import Settings
from wildstring.database import Database


def main() -> None:
    password = getpass("New admin password (12–128 characters): ")
    if password != getpass("Confirm password: "):
        raise SystemExit("Passwords do not match")
    settings = Settings()
    database = Database(settings.data_dir)
    database.initialize()
    try:
        Auth(database, settings).set_password(password)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    print("Admin password saved. All existing sessions have been revoked.")


if __name__ == "__main__":
    main()
