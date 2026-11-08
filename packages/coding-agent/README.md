# Octocode Code

A terminal coding agent that researches code before it changes it, and splits big work across a team of subagents and git worktrees.

**The full guide, with diagrams of how it works, is the [main README on GitHub](https://github.com/bgauryy/octocodecode#readme).**

## Install

Needs Node 24.15 or later (Node 24 line).

```sh
npm install -g @octocodeai/octocodecode
cd your-project
octocode
```

Trust the folder when asked, then `/providers` to connect an AI provider, `/model` to pick a model, and type your task. `/octocode auth login` connects GitHub for code search. `/help` lists every command.

The package installs `octocode` and `octocode-api`. If the separate `octocode` research package is installed globally, npm reports `EEXIST` for the shared command name: remove that package first, or install with `--force`.

## What it does

- **Octocode research out of the box:** local, AST, LSP, GitHub and package search through the built-in `octocode` MCP server.
- **Tools:** `bash`, a guarded `file` writer with `/rewind` checkpoints, `web`, `agent`, `backlog`, `archive`, smart `timer` wake-ups.
- **Teams:** subagents with roles (researcher, implementer, reviewer, browser, lean), file locks, team mail, isolated worktrees, a backlog the coordinator drives.
- **Extend:** any MCP server, skills, Claude and Codex plugins and hooks, and the setup of Pi, Claude Code, Codex and Cursor through `/harness`.
- **Models:** hosted providers with OAuth or API keys, local llama.cpp and Ollama, layered prompt caching with warming.
- **Interfaces:** terminal, `/web` workspace, `/remote` links, tmux, ACP for editors, print, JSON and RPC modes, a local session API.

Documentation ships in this package under `docs/`; start with [docs/index.md](docs/index.md).

MIT; original Pi copyright notices are retained in [LICENSE](LICENSE). Licenses of the third-party code compiled into the bundle are in `dist/licenses/THIRD_PARTY_NOTICES.md`.
