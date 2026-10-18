# Security policy

## Supported versions

Security fixes target the latest stable release and the `main` branch. Older releases are not maintained separately; upgrade both the server and Android client when a fix is released.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/qingmuhy744/wildstring/security/advisories/new) for suspected vulnerabilities. Include affected versions, reproduction steps, expected and observed behavior, and the potential impact. Redact API keys, passwords, session cookies, personal music and private server addresses from examples and attachments.

Reports are reviewed by the maintainer on a best-effort basis. Please keep unpatched vulnerabilities private while a fix is being investigated. The maintainer will coordinate disclosure and publish a security advisory when appropriate.

For a leaked credential, revoke or rotate it at its issuer immediately; deleting it from the current file does not remove it from Git history or invalidate it.

## Security boundaries

- Import sources are read-only. Managed music copies and database changes follow the application's normal permissions and explicit confirmation flows.
- Install source plugin ZIPs only from maintainers you trust. They contain server-side Python code; worker limits are not an operating-system sandbox.
- Treat imported tags, lyrics, webpages, AI output and plugin results as untrusted input. AI tools use the same permission checks as ordinary requests.
- Public deployments should use HTTPS, secure cookies, strong account passwords and protected persistent storage. Do not include private configuration or music files in public reports.
