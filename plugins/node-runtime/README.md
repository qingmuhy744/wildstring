# Metadata provider runtime dependencies

The community providers remain pinned to reviewed upstream commits. WildString only
exposes their metadata and lyric endpoints. `npm ci --ignore-scripts` installs the
locked graph and never runs upstream install hooks.

`vendor/*-metadata` contains only the required upstream modules, with original MIT
licenses and `UPSTREAM.json` provenance and file hashes. Reproduce or verify them
with `python scripts/vendor_source_providers.py [--check]`; archives are checked
against pinned SHA-256 values, established from the prior lockfile sources. npm workspaces install
these packages under their own names, without overriding another package's identity.

Provider adaptations keep unused functionality out of the installed graph and ZIPs:

- `node-forge` is replaced with **@wildstring/native-rsa**. This is independently
  written compatibility code backed by Node/OpenSSL, not a patched copy of Forge.
  It only implements the providers' RSA public-key encryption and byte conversions.
  It exposes no signature verification, certificate processing or private-key API.
- `pac-proxy-agent` is replaced with **@wildstring/no-pac**. PAC remains unsupported;
  explicit HTTP(S) proxies continue through the providers' existing implementation.
  The PAC interpreter and its transitive FTP client are not installed.
- Metadata subsets exclude playback URL signing, cloud-list mutations, simulated
  behavior, neapi/xeapi and filesystem token/key caches. NetEase's active weapi
  key generation uses `crypto.randomInt`; ordinary metadata, eapi and lyrics stay
  compatible with their original wire formats.

These adaptations belong to the provider packages. Review the required surface
when changing upstream commits; unsupported operations must fail rather than silently
use a different algorithm. `npm test` checks protocol padding, binary data, OAEP,
failure cases and real upstream encryption entry points. Upstream and dependency
license notices continue to ship in every ZIP.
