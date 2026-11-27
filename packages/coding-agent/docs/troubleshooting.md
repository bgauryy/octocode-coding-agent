# Troubleshooting

Start with `/status` in a session: it shows the model, the provider, quota windows and the recent errors. Run `octocode --version` to check the install. For slow or stuck work see [monitoring](monitoring.md); for how a turn and compaction behave, [how it works](how-it-works.md).

## Install and start

| Symptom                                                          | Cause and fix                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Octocode needs Node >= 24.15.0 (found vX)`                      | Your Node is older than the supported floor. Install the current LTS from [nodejs.org](https://nodejs.org); Node 24 (from 24.15.0) and Node 26 are tested.                                                               |
| `npm install -g` fails with `EEXIST` on the `octocode` file      | Another package already owns the global `octocode` command, usually the research CLI package `octocode`. Remove it with `npm uninstall -g octocode` and install again, or install with `--force` to replace the command. |
| `octocode: command not found` after install                      | The global npm folder is not on `PATH`. Run `npm prefix -g` and add its `bin` folder (on Windows, the folder itself) to `PATH`, then open a new terminal.                                                                |
| The process stops with `Octocode stopped on an unexpected error` | A bug. Print, JSON, RPC and ACP runs print this one line and exit with a non-zero code. Report it with `/bug` in a session, or the line and your version.                                                                |

## Providers and models

| Symptom                                 | Fix                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "No provider" or no models in `/model`  | Nothing is signed in. Run `/providers` and connect an account or paste an API key; in a script, set the provider's key variable (see [providers](providers.md)). Local models (Ollama, llama.cpp) need their server running first. |
| A headless run exits asking for sign-in | Text, JSON and RPC runs cannot open `/providers`. Sign in once interactively, or provide the key through the environment of that run.                                                                                              |
| `401` or "invalid key"                  | The key was revoked or belongs to another provider. Reconnect in `/providers`; the page checks a key when you save it.                                                                                                             |

## Untrusted folder

Octocode reads project settings, instructions, hooks and MCP servers only from a folder you trust. In a terminal it asks the first time. Headless runs refuse an untrusted folder instead of asking:

```sh
octocode trust add /path/to/project   # record trust once
octocode --mode rpc --trust           # or grant it for this start
```

Inside a session, `/trust` shows and changes the decision. Details: [permissions](permissions.md) and [configuration](configuration.md).

## Rate limits and 429

A `429` or "too many requests" means the provider is limiting you, not that the key is wrong. Octocode retries with a growing wait and honours the provider's `retry-after`; a plain rate limit never switches model. A usage or billing limit (quota, no funds) is different: it does not recover in minutes, so Octocode moves to a fallback model if you set one and otherwise stops with the reset time.

To stay under a provider's limit before it answers `429`, each session paces its model requests with the `requestsPerMinute` setting (default 12 per session, applied to the requests of that session and its helpers). Raise it if your plan allows more, lower it when many sessions share one key. Parallel sessions and subagents each count separately, so many of them on one key can still reach the provider's limit. See [settings](settings.md) for the exact name and scope, and [configuration](configuration.md) for retries.

## VS Code terminal

Slow repaints, a coloured triangle or black block, or a session that looks frozen usually come from VS Code's renderer. Keep `terminal.integrated.gpuAcceleration` at `auto` and try the Octocode `tuiMode` and `terminal` settings: [VS Code terminal in the terminal UI guide](tui.md#vs-code-terminal) lists each check and the known VS Code bugs.

## Windows

| Topic          | Note                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal       | Use Windows Terminal or the VS Code terminal. Run each session in its own tab: split terminals with busy sessions can freeze the desktop (see the VS Code section above).   |
| Sandbox        | Command sandboxing exists on macOS and Linux only. Leave `sandbox.mode` at `"off"`; the first command otherwise asks whether to run unsandboxed. See [sandbox](sandbox.md). |
| Shell          | `bash` commands run in the shell Octocode finds on the machine. If none is found, install Git for Windows and reopen the terminal.                                          |
| Paths          | Quote paths with spaces. Both `C:\code\app` and `C:/code/app` work.                                                                                                         |
| Stopping a run | `Ctrl+C` stops the current turn; in headless runs it exits with code 130.                                                                                                   |

## Still stuck

Run the failing command again with `--verbose`, check [configuration](configuration.md) for which file wins, and report with `/bug`, which removes secrets from what it collects.
