# Configuration

## Agent directory

Octocode Code stores configuration and runtime state under `~/.octocode/octocodecode/`.
Set `OCTOCODE_HOME` to move that root. `OCTOCODE_CODING_AGENT_DIR` overrides only
the core configuration directory. Project configuration remains in `.octocode/`.

Place provider configuration in `models.json` within that directory.
See [models](models.md) and [environment variables](environment-variables.md).

## Pi configuration fallback

With the default home, Octocode also reads `~/.pi/agent/` and `~/.pi/`, in that
order. Octocode configuration takes precedence:

- `models.json`: providers missing from Octocode are read from Pi. An Octocode
  provider replaces the whole Pi provider, including credentials and models.
- `settings.json`: missing settings are inherited. Native values win, including
  nested settings. Saving settings writes the effective configuration to the
  Octocode directory; the Pi files are unchanged.
- Extensions, skills, prompts and themes: default directories and configured
  paths are read relative to their original Pi directory. An identically located
  native resource wins. Existing package resources are supported; missing Pi
  packages are not installed automatically. `--no-extensions` disables inherited
  extensions too.
- Extension packages may declare `octocode` or legacy `pi` resources in
  `package.json`; `octocode` wins when both are present. Imports from both
  `@mariozechner/pi-*` and `@earendil-works/pi-*` resolve to the Octocode host.

The old `@octocodeai/pi-extension` package is not automatically loaded alongside
the native features it duplicates. Other extensions can still register their
own tools and commands; normal conflict diagnostics apply.

Explicit home overrides and custom SDK directories disable automatic Pi fallback.
Pi sessions, trust decisions, authentication files, device identity and telemetry
consent are not imported. Existing directories are neither moved nor deleted.
The separate agents-communication service keeps its shared directory at
`~/.octocode/agents-communication/`.

## Historical migrations

Run `octocode migrate` explicitly to convert older files in the active Octocode
configuration directory and the current project's `.octocode/`. Normal startup
does not run these conversions or wait for a migration acknowledgement.

The command adds missing providers from `oauth.json` and `settings.json` API keys
to `auth.json`, preserving existing providers. It moves loose session files into `sessions/`, moves managed
search binaries from `tools/` to `bin/`, rewrites historical keybinding names,
and renames `commands/` to `prompts/` when the destination is absent. It reports
deprecated extension directories for manual review. Existing old keybinding
names still load in memory without rewriting the file.

Back up historical files before conversion. This command does not import or
modify the Pi fallback directories. Use `octocode migrate --help` for the active
configuration path.
