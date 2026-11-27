# Resume External Harness

Bundled with Octocode. It teaches agents to find Claude Code, Codex, Cursor, Antigravity (`agy`) and earlier Octocode sessions recorded for the current repository and its worktrees, read one back as a digest, and continue its work in Octocode or hand it back to its own tool. It also reports the repository's worktrees, including ones whose folder was deleted or that git no longer lists.

- Start at [SKILL.md](SKILL.md).
- Script: `node scripts/sessions.mjs list | show <ref> | worktrees | locations` (`--help` for options). It only reads the other tools' folders and prints git commands without running them.
- Output: [output.md](output.md). Storage layouts: [references/formats.md](references/formats.md).
- Setup: Node 22 or later and git. `sqlite3` for Cursor's and Antigravity's databases; Node 23.8+ or `zstd` for compressed Codex rollouts.
