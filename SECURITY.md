# Security

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/davidprokopec/opencode2-waits/security/advisories/new).
Please do not open a public issue for a vulnerability.

## What this plugin can do

It runs inside OpenCode, in the background service and in the TUI, with the
same privileges as OpenCode itself. Specifically it:

- reads and writes JSON files under
  `$XDG_DATA_HOME/opencode-waits/waits/` (the legacy-compatible path, default
  `~/.local/share/...`),
- submits prompts into your OpenCode sessions when a wait matures,
- makes no network requests of its own and runs no shell commands.

## Trust boundary worth knowing

A pending wait is a file containing a session id and prompt text. Anything able
to write into the store directory can therefore cause an arbitrary prompt to be
submitted to one of your sessions at a time of its choosing. The directory sits
under your user's data directory and is protected by ordinary filesystem
permissions; there is no additional signing. This is only a concern if you
already share that account with something you do not trust.

Records that do not parse are skipped rather than trusted, so a corrupt or
hostile file cannot take out other pending waits.

## Supply chain

Releases publish from GitHub Actions using npm trusted publishing (OIDC), so no
long-lived npm token exists to leak, and every published version carries a
provenance attestation linking it to the workflow run and commit that built it.
Verify with:

```sh
npm audit signatures
```

CI pins its actions to commit SHAs and installs with `--frozen-lockfile
--ignore-scripts`, so no dependency lifecycle script executes in the release
path.
