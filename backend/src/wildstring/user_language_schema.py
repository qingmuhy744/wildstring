"""Schema 43: store each account's interface language preference."""

LANGUAGES = ("auto", "zh", "en")


def migrate(connection):
    connection.execute("BEGIN IMMEDIATE")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
    if "language" not in columns:
        connection.execute(
            "ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'auto' "
            "CHECK(language IN ('auto','zh','en'))"
        )
    connection.execute("PRAGMA user_version=43")
    connection.commit()


def resolve_language(preference: str | None, accept_language: str | None) -> str:
    """Return the concrete UI language for an account preference and request.

    An explicit account choice wins. ``auto`` follows the client's
    Accept-Language header; Chinese variants map to ``zh`` and every other
    language falls back to English.
    """
    if preference in ("zh", "en"):
        return preference
    ranked = []
    for index, part in enumerate((accept_language or "")[:512].split(",")):
        tag, _, params = part.strip().partition(";")
        tag = tag.strip().lower()
        if not tag or tag == "*":
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.strip().partition("=")
            if key.strip() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        if quality > 0:
            ranked.append((-quality, index, tag))
    for _, _, tag in sorted(ranked):
        primary = tag.split("-", 1)[0]
        if primary == "zh":
            return "zh"
        if primary == "en":
            return "en"
    return "en"
