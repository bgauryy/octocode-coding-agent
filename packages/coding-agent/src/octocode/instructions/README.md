# Instructions: the model-facing prompt text

Every sentence the model reads from Octocode itself lives in this folder as Markdown, except the text that belongs to a tool or to the MCP server (see [Where the rest lives](#where-the-rest-lives)). Browse the folder to read it; read [`rendered/`](rendered/README.md) to see the full context each agent receives.

```text
instructions/
  README.md          this map
  policy/            work.md research.md delegation.md subagent.md safety.md communication.md scratch.md
  lean/              lean.md                  (the whole policy of a `lean: true` child)
  subagent/          identity.md worktree.md team.md report.md   (a child's task message)
  system/            preamble.md docs.md rules-bash.md rules-floor.md project-context.md environment.md
  workflows/         planning.md plan-approved.md plan-reminder.md side-question.md summarization.md title.md
  roles/             researcher.md implementer.md reviewer.md browser.md lean.md   (profiles with front matter)
  rendered/          GENERATED context per agent (system, tools, messages, sizes); never edit
  policy.ts lean.ts task.ts report.ts   thin TypeScript: derive the flags once, render the files
```

## How a file is written

A file is plain Markdown plus a small template syntax (renderer: [`../../core/prompt-template.ts`](../../core/prompt-template.ts)):

- `{{name}}` inserts a value the TypeScript passes in; an unknown name is an error.
- `{{#if flag}}…{{else}}…{{/if}}` and `{{#unless flag}}…{{/unless}}` work inline and on lines of their own; a block that is off on its own lines leaves no blank line.
- `<!-- … -->` comments are removed. Each file starts with one that lists its flags and values; the `User request (date)` comments keep the reason for a rule beside the rule.
- Every file ends with a newline; the renderer drops the last one.

Change the text here, never in the TypeScript. A new condition is a new named flag in `policy.ts` (`policyFlags`), then `{{#if}}` in the file. After an edit run `yarn workspace @octocodeai/octocodecode run generate:prompts`; `test/octocode/e2e-agent-context.test.ts` fails while `rendered/` is stale, and the prompt tests pin exact wording.

## Assembly order

The core assembles the prompt from named sections in the order of `core/system-prompt-spec.ts` (`composeSystemPromptSections`); each is wrapped in a tag of its name, and `preamble` is bare. The tier decides cache reuse: `base` sections depend only on tools and the install, `session` on the project and request, `volatile` change within a session.

| Order | Section | Tier | Source | Condition |
| --- | --- | --- | --- | --- |
| 1 | `preamble` | base | `system/preamble.md` | replaced by a custom prompt (`SYSTEM.md`) |
| 2 | `tools` | base | each tool's `promptSnippet` | declared, non-MCP tools with a snippet |
| 3 | `rules` | base | tool `promptGuidelines`; `system/rules-bash.md`, `system/rules-floor.md` | bash line: no custom prompt, `bash` declared and Octocode search not routed; floor: no custom prompt and no `octocode_communication` section |
| 4 | `docs` | base | `system/docs.md` | dropped under a custom prompt; cleared for subagents |
| 5 | `mcps` | base | `packages/mcp/src/section.ts` | MCP servers connected or declared |
| 6 | `addendum` | session | `APPEND_SYSTEM.md` | user file present |
| 7 | `project_context` | session | `system/project-context.md` + AGENTS.md files | context files found |
| 8 | `skills` | session | `core/skills.ts` (`formatSkillsForPrompt`) | skills present and a reader tool |
| 9 | `cwd` | session | working directory | always |
| 10 | `octocode_work` | session | `policy/work.md` | not a lean child; `main` or `child`, `readOnly`, `shell`, `canSave` |
| 11 | `octocode_research` | session | `policy/research.md` | `octocode`, `shell`, `web`, `readOnly`, `browse` |
| 12 | `octocode_delegation` | session | `policy/delegation.md` (main) or `policy/subagent.md` (child) | main: only with the agent tool; `browserProfiles`, `profiles`; child: `canSave`, `agentTool` |
| 13 | `octocode_safety` | session | `policy/safety.md` | `main`/`child`, `agentTool`, `gitState` |
| 14 | `octocode_communication` | session | `policy/communication.md` | `main`/`child`, `readOnly`, `agentTool`, `canAsk` |
| 15 | `octocode_lean` | session | `lean/lean.md` | a `lean: true` child instead of 10–14 |
| 16 | `role` | session | `roles/<profile>.md` body | a subagent with a profile |
| 17 | `environment` | volatile | `system/environment.md` | always (date changes it) |
| 18 | `planning` | volatile | `workflows/planning.md` | planning active |
| 19 | `mcp_status` | volatile | `packages/mcp/src/section.ts` | server status changes |

`octocode/turn.ts` (`registerTurnSetup`) chooses `policy.ts` or `lean.ts` for each request, and `octocode/tool-loadout.ts` rebuilds the prompt through `core/system-prompt.ts` when the tools change.

Flags are derived once, in `policyFlags` of `policy.ts`: audience (`main` = the session that answers the user, `child` = a subagent, `readOnly` = a read-only role) and tools (`shell`, `web`, `mcp`, `canSave`, `canAsk`, `agentTool`, `octocode`, `browse`).

## A child's task message

The facts only one child has ride in its first message, after the parent's task, so every child of a profile shares a cached system prompt: `subagent/worktree.md` (isolated checkouts), `subagent/identity.md` (`## You`, then the report contract from `subagent/report.md`) and `subagent/team.md` (collaborating children). Code: `task.ts`, `report.ts` (the parsed outcome words and the 8 KB preview are values in the text, so the parent and the child agree).

## Where the rest lives

- **Tool descriptions, snippets and guidelines** stay in each tool module (for example `octocode/files/tool.ts`, `octocode/agent-tool.ts`), because they change with the tool's behavior. They appear in `<tools>`, `<rules>` and the tool declarations; each agent's `rendered/<agent>/tools.md` shows them as the model receives them.
- **MCP section text** stays in `packages/mcp` (a separate workspace that may not import coding-agent): `src/section.ts`, `src/presets/`. It appears as `<mcps>` in `rendered/main/system.md`, and the connected server's tool declarations in `rendered/main/tools.md`.
- **Compaction prompts and the checkpoint format** stay in `core/compaction/` (`summary-format.ts`): code parses their headings. The summarizer's system prompt is `workflows/summarization.md`.
- **Skills wrapper** text is in `core/skills.ts`; prompt-hook evaluation in `octocode/hooks/prompt.ts`; runtime notices (budget stops, mail, restore) in the module that sends them.

## Shipping and generating

The Markdown folders are read at run time through `getInstructionsDir()` (`src/config.ts`): `src/` in a checkout, `dist/octocode/instructions/` in the package, `instructions/` next to a compiled binary. `scripts/copy-instructions.mjs` copies them for the package build (`copy-assets`) and `scripts/stage-binary.mjs`; `README.md`, `rendered/` and the TypeScript are not copied.

`yarn workspace @octocodeai/octocodecode run generate:prompts` rewrites `rendered/` by running `test/octocode/e2e-agent-context.test.ts` with `-u`; without `-u` the same test fails while a file differs, is missing or is not produced by any agent. The capture code is in `test/octocode/agent-context/` (`capture.ts` starts the sessions, `analyze.ts` measures them, `render.ts` writes the files). The machine's date, platform, shell and paths are replaced by fixed placeholders, so the files are the same on every machine.

### Reading `rendered/`

[`rendered/README.md`](rendered/README.md) is the index: one row per agent (`main`, `general` = a child without a role, `researcher`, `implementer`, `reviewer`, `browser`, `lean`) with total characters, estimated tokens (characters / 4), the System, Native tools, MCP tools and Messages sizes, and the largest parts. Each agent folder holds:

- `system.md`: the whole system prompt, section by section.
- `tools.md`: every tool declaration the model receives, with its description and pretty-printed parameter schema; MCP tools included.
- `messages.md`: the conversation of the first request (for a child, the task message with `## You` and `## Report`).
- `sizes.md`: every system section, tool and message ranked by size, and the sentences of 50+ characters that appear word for word in two or more places of that agent's context. Repeated sentences are simplification candidates: keep the sentence in the one place that owns it. Nothing fails on them.

The main session is a real session; each child is started the way `subagents/tool.ts` starts one, so a change to a profile, flag or tool list shows up in the child's files. The parent's task text and the goal are placeholders.
