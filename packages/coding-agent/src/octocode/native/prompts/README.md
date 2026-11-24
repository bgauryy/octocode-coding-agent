# Prompts: the model-facing prompt text

Every sentence the model reads from Octocode itself lives in the native folder (`octocode/native/`) as Markdown, except the text that belongs to a tool or to the MCP server (see [Where the rest lives](#where-the-rest-lives)). Browse the folder to read it; read `.octocode/agent/tmp/agent-prompts/`, which every build writes, to see the full context each agent receives. The committed, templated version of each agent's final prompt is in [`final/`](final/README.md).

```text
native/
  prompts/           this folder: prompt sections, shared rules, notices and workflows
  tools/             each tool's snippet and guidelines (`tools/<tool>/snippet.md`, `guidelines.md`); `tools/archive/description.md` describes archive reads; `tools/bash/cli.md` is the CLI guide appended to the bash description
  hooks/             context.md (hook output the model reads), evaluation.md (the prompt-hook judge)
  agents/            researcher.md implementer.md reviewer.md browser.md desktop.md lean.md   (profiles with front matter)
  skills/            the skills Octocode ships (`octocode-debugging`, ...)

prompts/
  README.md          this map
  sections/          index.md: the map of every prompt section; <name>.md: a template composing that section's parts
  shared/            one rule each, included by the policies that need it (`{{> shared/rule.md}}`)
  policy/            the parts of the `work`, `research`, `delegation` (main session), `children` (main session, from its first child or message to an agent), `subagent` (every subagent), `safety` and `communication` sections; the `work` section joins understand.md, change.md or readonly.md, and finish.md: understand.md change.md readonly.md finish.md research.md delegation.md children.md subagent.md safety.md communication.md scratch.md
  lean/              lean.md                  (the whole policy of a `lean: true` child)
  subagent/          identity.md worktree.md why.md report.md result-contract.md task-skills.md chain-handoff.md browser-mode.md   (a child's task message); role-skills.md (its role section); runner.md (an external runner's task message)
  notices/           runtime messages the model reads: compaction, recovery, resume, subagents, monitor (machine alerts, stuck jobs, context bands, check-ins, child silence, idle items), mail, backlog peers (`peer/`: facts about a change to a related item), the session provider's plan quota (`models/`), permission modes, the loop guard, the run's request and spend limits (`run-budget/`)
  system/            skill-references.md preamble.md docs.md rules-bash.md rules-floor.md project-context.md environment.md harnesses.md harness.md tools-on-demand.md; claude-code.md and claude-code-history.md (what a `claude-code/*` model's Claude Code is told, `claude-code/transcript.ts`)
  workflows/         planning.md plan-approved.md plan-reminder.md side-question.md summarization.md title.md optimize-prompt.md
                     memory/ rules.md reflect.md consolidate.md   (the small-model passes that curate the MEMORY.md files: what each file holds, the lesson pass at a long session's end, the daily merge)
  policy.ts lean.ts task.ts role.ts report.ts   thin TypeScript: derive the flags once, render the files
```

## How a file is written

A file is plain Markdown plus a small template syntax (renderer: [`../../../core/prompt-template.ts`](../../../core/prompt-template.ts)):

- `{{name}}` inserts a value the TypeScript passes in; an unknown name is an error.
- `{{> shared/rule.md}}` inserts another prompt file with the same values. A rule two prompts share lives once in `shared/`, not copied.
- `{{#if flag}}…{{else}}…{{/if}}` and `{{#unless flag}}…{{/unless}}` work inline and on lines of their own; a block that is off on its own lines leaves no blank line.
- Show branching logic or a lookup visually when that is no longer than the prose it replaces: a fenced `text` arrow list or tree (`condition → action`, `├─`/`└─`), a table, or a compact `mermaid` diagram, whichever is shortest and clear (`shared/ask-parent.md`, `policy/delegation.md`, `policy/readonly.md`). Keep simple linear one-liners as prose. Keep a block alone on its lines; in a Mermaid diagram keep labels free of `;`, `(`, `)` and `{{`, since the renderer does not parse it. The agent writes Mermaid to the user only when `<environment>` Renders says the surface draws it (`system/environment.md`: the terminal UI with `markdown.mermaid` on).
- Write no comments, size notes or other metadata in these files: only text the model reads (and a role's front matter). A short purpose clause is fine when it changes how the model applies the rule ("survives compaction"); history, dates and item ids belong in the commit or backlog item that added it.
- Every file ends with a newline; the renderer drops the last one.

Change the text here, never in the TypeScript. A new condition is a new named flag in `policy.ts` (`policyFlags`), then `{{#if}}` in the file. After an edit run `yarn workspace @octocodeai/octocode-agent run generate:prompts` and read the result; tests check behavior, not wording.

## Assembly order

The core assembles the prompt from named sections in the order of `core/system-prompt-spec.ts` (`composeSystemPromptSections`); each is wrapped in a tag of its name, and `preamble` is bare. Three sections are families: `mcps` gives one `mcps:<server>` section per server block, `project_context` one `project_context:<path>` per instruction file, and `environment` one `environment:<field>` per line (`date`, `platform`...). A family keeps one tag: its head section opens it, each member is bare, and the `<family>:/` section closes it, so one server connecting, one file changing or a new day patches only that member. The tier decides cache reuse: `base` sections depend only on tools and the install, `session` on the project and request, `volatile` change within a session.

[`sections/index.md`](sections/index.md) is the one map: every section of an agent's prompt in order, with its cache tier and what writes it, and each is wrapped in a tag of its name. The code reads that table (`core/system-prompt-spec.ts`), so changing it changes the prompt. A section in the `policy` or `lean` group lists its chunks in the Chunks column: prompt files in order, each followed by the flags it needs (`!flag`: only when the flag is off). `renderSectionChunks` renders the files whose flags hold and joins them; a rule shared by several chunks is its own file under `shared/`, included with `{{> shared/rule.md}}`. Dynamic sections come only from what the session loaded: `mcps` and `mcp_status` from its MCP servers, `hooks` from its hooks, and `tools` and `rules` from its tools. A section with nothing to say is removed.

`octocode/turn.ts` (`registerTurnSetup`) chooses `policy.ts` or `lean.ts` for each request, adds the `children` section as a section patch in the request after the session's first `agent` call that starts a child or messages an agent (and from the first request of a resumed session whose entries hold one), and `core/agent-session/tool-loadout.ts` rebuilds the prompt through `core/system-prompt.ts` when the tools change.

Flags are derived once, in `policyFlags` of `policy.ts`: audience (`main` = the session that answers the user, otherwise a subagent; `readOnly` = a read-only subagent, never the main session) and tools (`shell`, `web`, `mcp`, `canSave`, `agentTool`, `runner` (the `agent` tool declares a vendor CLI runner), `backlog`, `browserControl`, `desktopControl`, `research`, `localReader`, `askUser`); combinations a template reads by name: `gitState` (a subagent with a shell), `controlsApp` (a browser or desktop specialist). `research` is set when the agent can reach a research server, the first MCP server whose config entry gives tools both a `reader` and a `search` role (`currentToolRoles().research`, `packages/mcp/src/roles.ts`); `research.prefix` renders its namespace (the base prompt drops its own bash search rule when the research section names it, `core/system-prompt.ts`) and `research.reader` its reader's name, behind `localReader` (the reader is declared). Its search tools stay unnamed: no flag says which are declared.

Each MCP server explains itself through its instructions, tool descriptions and schemas (`<mcps>` and the declarations), and `mcp_status` names a server that is not ready. The policy states what applies to every agent and, without the research server, the native fallbacks. Do not add routing text for a server to the policy, a role, a tool description or `core/skills.ts`, and never write a server's or tool's name into them; change the server's own text instead. The research CLI is external too: the bash CLI guide lists it on PATH like any other program (`files/bash/cli-guide.ts`), and no instruction names its commands, flags, exit codes or output, which it documents itself. A server's tools may be named only as rendered from the roles in its config entry: `shared/research-routes.md` (in `policy/research.md`) routes source reads and searches to the research server's reader and search tools as its `<mcps>` block routes them, shell lookups that route names included, with bash where one of those tools refuses the path or fails, because agents read through bash without that rule; it never forbids a shell lookup the server's route assigns. The read hint after a bash read of source (`files/read-hint.ts`) points at the same tools. A tool's own text may name the dedicated tools for the work it should not do in generic terms: the `file` description names the reads that count by role. Which tool answers which question stays the server's text.

Text here is for the agent reading it, so anything that depends on what a session loaded comes from what is loaded: a server's tools from `<mcps>`, skills from the `skill` tool's description (`tools/skill/description.md`, built from the session's skills), profiles from the list, and a tool named in policy only behind the flag saying it is declared. A role's `skills:` and `tools:` are defaults, and one that is not available is left out. Generated output stays out of this folder.

## A child's task message

The facts only one child has ride in its first message, after the coordinator's task, so every child of a profile shares a cached system prompt: `subagent/worktree.md` (isolated checkouts), `subagent/why.md` (the reason of the agent call that started it), `subagent/identity.md` (`## You`, which also says every child works on its coordinator's team, then the report contract from `subagent/report.md`). `identityBlock` (`task.ts`) renders the worktree note, the why and the identity as one block, which `withIdentity` appends to the task and which can be sent again on its own; the identity names the run mode (background or foreground) only when the caller passes it. Code: `task.ts`, `report.ts` (the parsed outcome words and the 8 KB preview are values in the text, so the coordinator and the child agree).

After a child's context is compacted, `subagents/identity-reminder.ts` sends the latest assignment its caller gave it again as a hidden message at the tail: the identity block, the browser mode line, the skill pointers and the result contract, rendered by the same functions (`task.ts`, `subagents/task-text.ts`). A task resume replaces the assignment, so the reminder carries the newest goal and item. It does not repeat the task text or inline skill bodies.

## Where the rest lives

Everything the model reads from Octocode is here, except:

- **A tool's `description` and schema fields** stay in its module (`AGENTS.md`: tool descriptions own tool mechanics, and they change with the tool). Its snippet and guidelines are in `tools/<tool>/`. So are a tool's results, refusals and errors, which reply to a call and stay with the code that makes them.
- **An MCP server's own text** comes from the server verbatim: nothing rewrites its descriptions, schemas or instructions. The wording around it is here: `sections/mcps.md`, `mcp-server.md` and `mcp_status.md`, rendered through the MCP host's `render.instruction` port.
- **Headings and markers code parses** stay beside their parser (`core/compaction/summary-format.ts`, `summary-view.ts`, the `<skill>`, `<saved-results>` and `<summary>` tags) and reach the Markdown as `{{values}}`.

Each agent's `<agent>/` folder shows all of it as the model receives it.

## Shipping and generating

The Markdown is read at run time through `getNativeDir()` (`src/config.ts`): `src/octocode/native/` in a checkout, `dist/octocode/native/` in the package, `native/` next to a compiled binary. A file's key is its path under `prompts/` (`policy/finish.md`), or under `native/` for `tools/`, `hooks/` and `agents/` (`tools/bash/cli.md`); `PROMPT_FOLDERS` in `core/prompt-template.ts` lists them. `scripts/build/copy-native.mjs` copies the folder for the package build (`scripts/build/build-coding-agent.mjs`) and `scripts/build/stage-binary.mjs`; READMEs, `final/` and the TypeScript are not copied.

Every `build:offline` writes each agent's final prompt to `.octocode/agent/tmp/agent-prompts/`, a temp folder Git ignores; `yarn workspace @octocodeai/octocode-agent run generate:prompts` does it alone (`scripts/write-agent-prompts.ts`, with the capture code in `test/octocode/agent-context/`). `generate:prompts --exposure direct` captures the same agents with every tool declared in full into `.octocode/agent/tmp/agent-prompts-exposure-direct/` for comparison, leaving the default capture alone. `test/octocode/e2e-agent-context.test.ts` checks what each context must hold. The machine's date, platform, shell and paths are replaced by fixed placeholders.

### Reading the prompts

The folder's `README.md` links each agent (`main`, `general` = a child without a role, `researcher`, `implementer`, `reviewer`, `browser`, `lean`). Each agent folder holds only the text the model receives, with no sizes or other metadata:

- `system.md`: the whole system prompt, section by section.
- `tools.md`: every tool declaration the model receives, with its description and pretty-printed parameter schema; MCP tools included.
- `messages.md`: the conversation of the first request (for a child, the task message with `## You` and `## Report`).

The main session is a real session; each child is started the way `subagents/tool.ts` starts one, so a change to a profile, flag or tool list shows up in the child's files. The parent's task text and the goal are placeholders. The model is scripted: these files show what Octocode sends, not how a provider caches or answers it.

An MCP tool has three layers, and these files show the first two:

- **Provider declaration** (`tools.md`): the trigger line and the field names and types: top-level fields, the fields of a top-level object or array of objects, and of arrays of objects inside those, at most 32 names per object (`thinParameters`, `packages/mcp/src/presentation/declaration.ts`). A tool the block does not describe yet (one a server added after it was described) keeps its full JSON declaration until the block is described again.
- **Contract the model reads** (`<mcps>` in `system.md`): the server's instructions and each enabled tool's description and signature (or its JSON Schema with `mcpPresentation: "json"`).
- **The server's own input schema** (its `tools/list` reply): not rendered here. The host validates every call against it (`validationParameters`, `packages/mcp/src/tool-definition.ts`); whether the server checks again is up to the server. Permission, the read-only role guard and the plan gate decide separately whether a call may run.

Prompts that no agent folder shows, because no first request carries them: `workflows/` (compaction, side question, title, planning, bug report, the MEMORY.md passes), `../hooks/` and `notices/`.
