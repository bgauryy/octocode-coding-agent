# Instructions: the model-facing prompt text

Every sentence the model reads from Octocode itself lives in this folder as Markdown, except the text that belongs to a tool or to the MCP server (see [Where the rest lives](#where-the-rest-lives)). Browse the folder to read it; read `.octocode/tmp/agent-prompts/`, which every build writes, to see the full context each agent receives.

```text
instructions/
  README.md          this map
  sections/          index.md: the map of every prompt section; <name>.md: a template composing that section's parts
  shared/            one rule each, included by the policies that need it (`{{> shared/rule.md}}`)
  policy/            the parts of the `work`, `research`, `delegation`, `safety` and `communication` sections: work.md research.md delegation.md subagent.md safety.md communication.md scratch.md readonly.md
  lean/              lean.md                  (the whole policy of a `lean: true` child)
  subagent/          identity.md worktree.md why.md team.md report.md   (a child's task message); role-skills.md (its role section)
  notices/           runtime messages the model reads: compaction, recovery, resume, subagents, mail, hooks, the loop guard
  tools/             each tool's snippet and guidelines (`tools/<tool>/snippet.md`, `guidelines.md`)
  system/            skills-intro.md skill-references.md preamble.md docs.md rules-bash.md rules-floor.md project-context.md environment.md
  workflows/         planning.md plan-approved.md plan-reminder.md side-question.md summarization.md title.md optimize-prompt.md
  roles/             researcher.md implementer.md reviewer.md browser.md lean.md   (profiles with front matter)
  policy.ts lean.ts task.ts report.ts   thin TypeScript: derive the flags once, render the files
```

## How a file is written

A file is plain Markdown plus a small template syntax (renderer: [`../../core/prompt-template.ts`](../../core/prompt-template.ts)):

- `{{name}}` inserts a value the TypeScript passes in; an unknown name is an error.
- `{{> shared/rule.md}}` inserts another instruction file with the same values. A rule two prompts share lives once in `shared/`, not copied.
- `{{#if flag}}…{{else}}…{{/if}}` and `{{#unless flag}}…{{/unless}}` work inline and on lines of their own; a block that is off on its own lines leaves no blank line.
- A branching rule may be a fenced `mermaid` diagram when that is shorter than the prose it replaces (`shared/ask-parent.md`, `policy/delegation.md`). Keep labels free of `;`, `(`, `)` and `{{`, and keep a diagram alone on its lines: the renderer does not parse it, and the agent still never writes Mermaid to the user.
- Write no comments, size notes or other metadata in these files: only text the model reads (and a role's front matter). The reason for a rule belongs in the commit or backlog item that added it.
- Every file ends with a newline; the renderer drops the last one.

Change the text here, never in the TypeScript. A new condition is a new named flag in `policy.ts` (`policyFlags`), then `{{#if}}` in the file. After an edit run `yarn workspace @octocodeai/octocodecode run generate:prompts`; the prompt tests pin exact wording.

## Assembly order

The core assembles the prompt from named sections in the order of `core/system-prompt-spec.ts` (`composeSystemPromptSections`); each is wrapped in a tag of its name, and `preamble` is bare. The tier decides cache reuse: `base` sections depend only on tools and the install, `session` on the project and request, `volatile` change within a session.

[`sections/index.md`](sections/index.md) is the one map: every section of an agent's prompt in order, with its cache tier and what writes it, and each is wrapped in a tag of its name. The code reads that table (`core/system-prompt-spec.ts`), so changing it changes the prompt. A section in the `policy` or `lean` group is a template, `sections/<name>.md`, that composes its parts and states when each applies. Dynamic sections come only from what the session loaded: `mcps` and `mcp_status` from its MCP servers, `skills` from its skills, `hooks` from its hooks, and `tools` and `rules` from its tools. A section with nothing to say is removed.

`octocode/turn.ts` (`registerTurnSetup`) chooses `policy.ts` or `lean.ts` for each request, and `core/agent-session/tool-loadout.ts` rebuilds the prompt through `core/system-prompt.ts` when the tools change.

Flags are derived once, in `policyFlags` of `policy.ts`: audience (`main` = the session that answers the user, otherwise a subagent; `readOnly` = a read-only subagent, never the main session) and tools (`shell`, `web`, `mcp`, `canSave`, `agentTool`, `externalAgent`, `research`, `localReader`, `askUser`). `research` is set when the agent can reach a research server, the first MCP server whose config entry gives tools both a `reader` and a `search` role (`currentToolRoles().research`, `packages/mcp/src/roles.ts`); `research.prefix`, `research.reader` and `research.search` render its namespace and tool names from those roles.

Each MCP server explains itself through its instructions, tool descriptions and schemas (`<mcps>` and the declarations), and `mcp_status` names a server that is not ready. The policy states what applies to every agent and, without the research server, the native fallbacks. Do not add routing text for a server to the policy, a role, a tool description or `core/skills.ts`, and never write a server's or tool's name into them; change the server's own text instead. A server's tools may be named only as rendered from the roles in its config entry: `policy/research.md` routes code search and reads to the research server's search and reader tools instead of bash, because agents read through bash without that rule. A tool's own `promptSnippet` may name the dedicated tools for the work it should not do in generic terms (for example `bash`: search and read with the declared search and read tools). Which tool answers which question stays the server's text.

Text here is for the agent reading it, so anything that depends on what a session loaded comes from what is loaded: a server's tools from `<mcps>`, skills from the catalog, profiles from the list, and a tool named in policy only behind the flag saying it is declared. A role's `skills:` and `tools:` are defaults, and one that is not available is left out. Generated output stays out of this folder.

## A child's task message

The facts only one child has ride in its first message, after the parent's task, so every child of a profile shares a cached system prompt: `subagent/worktree.md` (isolated checkouts), `subagent/why.md` (the reason of the agent call that started it), `subagent/identity.md` (`## You`, then the report contract from `subagent/report.md`) and `subagent/team.md` (collaborating children). `identityBlock` (`task.ts`) renders the worktree note, the why and the identity as one block, which `withIdentity` appends to the task and which can be sent again on its own; the identity names the run mode (background or foreground) only when the caller passes it. Code: `task.ts`, `report.ts` (the parsed outcome words and the 8 KB preview are values in the text, so the parent and the child agree).

After a child's context is compacted, `subagents/identity-reminder.ts` sends the latest assignment its caller gave it again as a hidden message at the tail: the identity block, the browser mode line, the skill pointers and the result contract, rendered by the same functions (`task.ts`, `subagents/task-text.ts`). A task resume replaces the assignment, so the reminder carries the newest goal and item. It does not repeat the task text or inline skill bodies.

## Where the rest lives

Everything the model reads from Octocode is here, except:

- **A tool's `description` and schema fields** stay in its module (`AGENTS.md`: tool descriptions own tool mechanics, and they change with the tool). Its snippet and guidelines are in `tools/<tool>/`. So are a tool's results, refusals and errors, which reply to a call and stay with the code that makes them.
- **An MCP server's own text** comes from the server, with shipped rewrites in `packages/mcp/src/presets/`. The wording around it is here: `sections/mcps.md`, `mcp-server.md` and `mcp_status.md`, rendered through the MCP host's `render.instruction` port.
- **Headings and markers code parses** stay beside their parser (`core/compaction/summary-format.ts`, `summary-view.ts`, the `<skill>`, `<saved-results>` and `<summary>` tags) and reach the Markdown as `{{values}}`.

Each agent's `<agent>/` folder shows all of it as the model receives it.

## Shipping and generating

The Markdown folders are read at run time through `getInstructionsDir()` (`src/config.ts`): `src/` in a checkout, `dist/octocode/instructions/` in the package, `instructions/` next to a compiled binary. `scripts/copy-instructions.mjs` copies them for the package build (`scripts/build-coding-agent.mjs`) and `scripts/stage-binary.mjs`; `README.md` and the TypeScript are not copied.

Every `build:offline` writes each agent's final prompt to `.octocode/tmp/agent-prompts/`, a temp folder Git ignores; `yarn workspace @octocodeai/octocodecode run generate:prompts` does it alone (`scripts/write-agent-prompts.ts`, with the capture code in `test/octocode/agent-context/`). `test/octocode/e2e-agent-context.test.ts` checks what each context must hold. The machine's date, platform, shell and paths are replaced by fixed placeholders. `scripts/agent-eval/understand.mjs` asks a small model running each prompt how it would work.

### Reading the prompts

The folder's `README.md` links each agent (`main`, `general` = a child without a role, `researcher`, `implementer`, `reviewer`, `browser`, `lean`). Each agent folder holds only the text the model receives, with no sizes or other metadata:

- `system.md`: the whole system prompt, section by section.
- `tools.md`: every tool declaration the model receives, with its description and pretty-printed parameter schema; MCP tools included.
- `messages.md`: the conversation of the first request (for a child, the task message with `## You` and `## Report`).

The main session is a real session; each child is started the way `subagents/tool.ts` starts one, so a change to a profile, flag or tool list shows up in the child's files. The parent's task text and the goal are placeholders. The model is scripted: these files show what Octocode sends, not how a provider caches or answers it.

An MCP tool has three layers, and these files show the first two:

- **Provider declaration** (`tools.md`): the trigger line and the top-level field names and types (`thinParameters`, `packages/mcp/src/presentation/declaration.ts`). A tool the block does not describe yet (one a server added after it was described) keeps its full JSON declaration until the block is described again.
- **Contract the model reads** (`<mcps>` in `system.md`): the server's instructions and each enabled tool's description and signature (or its JSON Schema with `mcpPresentation: "json"`).
- **The server's own input schema** (its `tools/list` reply): not rendered here. The host validates every call against it (`validationParameters`, `packages/mcp/src/tool-definition.ts`); whether the server checks again is up to the server. Permission, the read-only role guard and the plan gate decide separately whether a call may run.

Prompts that no agent folder shows, because no first request carries them: `workflows/` (compaction, side question, title, planning, hook evaluation, bug report) and `notices/`.
