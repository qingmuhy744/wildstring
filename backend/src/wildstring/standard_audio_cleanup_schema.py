"""Schema 39: existing audio follows the same collection rules as new audio."""


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    # Automatic legacy protection was created at version 1. Every explicit
    # protection change increments the version, so preserve those choices.
    connection.execute(
        "UPDATE podcast_resource_state SET protected=0,version=version+1 "
        "WHERE protected=1 AND version=1"
    )
    connection.execute("PRAGMA user_version=39")
    connection.commit()
