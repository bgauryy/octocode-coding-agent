# Skills

A skill is an instruction resource, separate from a [plugin package](plugins.md), an executable [extension](extensions.md), or an event-driven [hook](hooks.md).

Skills give Octocode specialized instructions and supporting files for a particular kind of work. Octocode advertises each available skill by name and description, then loads its full instructions only when the task calls for them.

Use a skill when a workflow needs more context than a prompt template but does not need a new executable integration point. Skills can bundle scripts, references, and assets alongside their instructions.

Octocode loads the instruction-resource portion of the [Agent Skills specification](https://agentskills.io/specification). Host-specific execution metadata needs a separate adapter; a readable skill is not evidence that every Claude or Codex field takes effect. Most invalid names produce warnings rather than stopping startup.

## Create a skill

A skill is a directory containing `SKILL.md`:

```text
pdf-tools/
├── SKILL.md
├── scripts/
│   └── extract.sh
├── references/
│   └── formats.md
└── assets/
    └── template.json
```

Start `SKILL.md` with frontmatter followed by direct instructions:

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run scripts relative to this skill directory.
```

The description determines when the model considers loading the skill. State both what the skill does and when it applies. Avoid descriptions such as “Helps with PDFs,” which do not provide enough routing information.

Use relative paths from the skill directory when referring to bundled files. Octocode tells the model where the skill lives so it can resolve those paths.

## Find and control skills

Run `/skills` (or `/skills list`) to inspect all discovered skills, including disabled ones: it shows load state, model/user invocation eligibility, source, and file path. Select a row to insert a loaded skill's command, see details, or change its state. `/skills <search>` keeps the quick picker for loaded, user-invocable skills.

| Command                          | Effect                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| `/skills info <name-or-path>`    | Show source, state, and exact file                                 |
| `/skills disable <name-or-path>` | Save an exclusion in user or trusted project settings, then reload |
| `/skills enable <name-or-path>`  | Save an inclusion in the same scope, then reload                   |

Use the exact path when names collide. A session-only or synthetic skill cannot be persisted with these commands. The commands change Octocode settings only; a shared skill file may have a different enable state in Claude, Codex, or OpenCode. `/skills list` may show an enabled skill as “not loaded” when its file is invalid, another skill won the same-name collision, or automatic skill loading is off; inspect startup diagnostics before assuming it reached the model. `octocode config` remains the broader terminal manager for skills and other resources.

## Understand how skills load

At startup, Octocode scans configured skill locations and adds each skill’s name, description, and path to the system prompt. It does not add the full instructions.

The skill entries share a budget of 8,000 characters (about 1% of a 200k-token window). A description longer than the 1,024-character limit is cut. When the entries do not fit, descriptions are dropped from the last skills first and the prompt says how many skills are listed without one; if the bare entries still do not fit, the last skills are named on one line without an entry. SDK callers can change the budget with the `budgetChars` option of `formatSkillsForPrompt`.

When a task matches, the model loads the skill and follows its instructions; the common policy tells it to do so before starting. Native sessions give the model a `skill` tool for this: it takes a skill's name and returns that skill's `SKILL.md` (front matter removed) with the skill's directory, so relative references resolve. It reads only skills the session loaded, refuses an unknown name with the close matches, and refuses a skill with `disable-model-invocation`. The tool is active in the main session and in subagents, and is left out of requests while no loaded skill allows model invocation. A profile can drop it with `excludeTools: skill`. Without the tool (an SDK session, or one that excludes it) the prompt names a file reader instead: Octocode `localFetch`, `read` or `bash`. The terminal draws a load as `Skill: <name>`, whether it came from the `skill` tool or from a `localFetch` read of a loaded skill's `SKILL.md`. Skills do not register an executable tool for each workflow. This keeps detailed guidance out of context until it is needed. A model might fail to load a relevant skill, so use a skill command when you need to load it explicitly.

The automatically managed Octocode MCP server allows reads inside each loaded skill's directory, including its references and assets. These resource roots include model-only skills and eligible path-selection candidates hidden by a name collision; they do not depend on slash-command visibility. Native sessions apply the same launch defaults to a configured local stdio server named `octocode` when neither its configuration nor the process environment sets `ALLOWED_PATHS`. The defaults are transient; configuration files stay unchanged. An explicit `ALLOWED_PATHS` wins, including an empty value. HTTP servers and custom SDK MCP factories keep their own access policy.

Extension-discovered skills are included before the first model request; changed skill roots reconnect the affected server. This does not grant access to unrelated sibling directories or symlinks that escape the allowed roots. Configure explicit allowed paths when your server needs a different workspace or access policy.

Use `/skills` in the terminal to find a loaded skill by name or description. Selecting it inserts its command in the editor. A skill named `pdf-tools` is available as `/pdf-tools` when that name does not conflict with a core command, an extension command, a prompt template, or another skill. `/skill:pdf-tools` remains a supported fallback.

A skill whose name conflicts with a command appears in discovery with the `skill:` prefix. When two discovered skills share a name, the first one found loads and the other is skipped with a collision warning (see [Write portable frontmatter](#write-portable-frontmatter)). Only an SDK `skillsOverride` that returns several skills with one name gives each a numbered command, such as `/skill:review:1` and `/skill:review:2`.

Native skill arguments after the command are appended to the loaded instructions as a user request:

```text
/pdf-tools extract report.pdf
```

Skills discovered under `.claude/skills` and configured Claude plugin skills use Claude’s zero-based `$0` / `$ARGUMENTS[0]`, raw `$ARGUMENTS`, and named placeholders from `arguments`. Inserted values are not expanded recursively. A single backslash escapes a recognized argument placeholder; missing indexed values stay literal. Arguments are appended with `ARGUMENTS:` only when no placeholder consumes them. This expansion happens at the user-command boundary; arbitrary model file reads do not apply it. After inserting arguments, explicit invocations replace `${CLAUDE_SESSION_ID}`, `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` with the current session, skill directory and the same project root used by hooks. Configured Claude plugin skills also replace `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` using the same local plugin identity as hooks. Unknown or unavailable variables stay literal, and inserted path values are not recursively expanded. `${CLAUDE_EFFORT}`, permission-rule substitution and dynamic execution remain compatibility gaps.

Set `disable-model-invocation: true` to omit a skill from the model’s advertised skill list. This does not prevent arbitrary file reads. Set `user-invocable: false` to hide its user commands and prevent direct or qualified command expansion while retaining model discovery. The `enableSkillCommands` setting controls whether skill commands appear in editor autocomplete; `/skills` and `/help` can still find them, and manually entered direct and `/skill:name` commands still work. SDK `getCommands()` and RPC `get_commands` also retain loaded skills when interactive suggestions are disabled.

## Select skills with Codex mentions

For a loaded native or Codex `SKILL.md`, write `$pdf-tools` anywhere in your request to include its full instructions. A configured Codex plugin uses its qualified name, such as `$my-plugin:pdf-tools`. Claude skills and loose Markdown resources retain their existing command behavior.

A name must identify exactly one eligible file. To select a particular discovered file, use a Markdown link:

```text
Use [$pdf-tools](/absolute/path/to/pdf-tools/SKILL.md) to inspect this report.
```

The link label does not select the file; its path must match an already discovered identity. Local absolute paths and `skill://` followed by a local absolute path are supported. Links cannot authorize reading arbitrary files. Path selections precede name selections, and repeated references to the same canonical file load it once. A missing or unreadable selected file produces a diagnostic while other selected skills continue loading.

Selection uses the request after input handlers, when that input is consumed. With Codex hooks enabled, selection and file reads wait for UserPromptSubmit acceptance, including queued input. Slash-command and template expansion retain their admission-time behavior. Selection does not rescan expanded templates or skill bodies. Dollar mentions inside code blocks or escaped text still count, matching the pinned Codex parser; common environment names such as `$HOME` and `$PATH` are excluded. Skills hidden from the implicit catalog can still be selected, but disabled, untrusted, product-excluded and `user-invocable: false` skills cannot use this route.

The original request and images stay separate from the selected instruction text parts in the same user message. Selected contents retain frontmatter; slash commands keep their existing argument and body expansion. Portable Codex plugins using root `plugin.json` have an 8,000-byte instruction limit, truncated at a UTF-8 boundary with a diagnostic. Legacy `.codex-plugin` skills do not use that limit.

This supports the pinned Codex local-host plaintext selector. Structured vendor input envelopes, remote/cloud catalogs and connector-name collision checks are not connected. Upstream emits separate contextual user items; Octocode groups the instruction text parts into the same user message. SDK resource loaders can supply `explicitSkills` to retain discovery identities; loaders supplying only `skills` capture identities when the request is expanded.

## Child skill inheritance

The native `agent` tool carries the accepted skill inventory into child sessions, including model-only resources and eligible Codex explicit candidates hidden by a name collision. Plugin names, invocation flags, argument substitution metadata and prompt byte limits survive the handoff. An explicit subset uses the parent's available skill command names; `skills: []` means no skills. See [subagent invocation](native-features.md).

The file loader captures canonical identities when it accepts skills; the handoff retains those identities and discovery aliases. Catalog paths, instruction reads and reference access stay with the captured resource when an alias changes. The inventory does not copy instruction bytes; edits to the same canonical file remain visible when read. A changed canonical identity or invalid snapshot fails the launch rather than rediscovering unrelated default resources. Synthetic SDK resources without a backing file cannot be inherited by a child process. Custom SDK loaders can set `Skill.canonicalPath` to retain an acceptance-time identity; when omitted, identity is resolved when the snapshot is captured.

Inheritance supplies instructions and reference roots. It does not activate executable plugin components or widen the child's tool permissions. Resuming a retained child uses its captured inventory, even if the parent later reloads its skills.

<a id="choose-where-it-loads"></a>

## Add it to Octocode

All public Octocode skills ship with the installed research CLI and are available automatically, including their scripts, references, and assets. Startup reads the installed files without downloading or copying skills into your home directory. Standalone releases include the same collection beside the executable. Updating Octocode updates these defaults.

When two skills share a name, the bundled skill beats a user-level copy another tool installed, so the agent gets the version this build ships. `npx octocode skill install` writes such copies into `~/.agents/skills/`, `~/.claude/skills/` and `~/.pi/agent/skills/` (also `$CODEX_HOME/skills/`); the same-name copy there is skipped and the bundled one is listed. Everything you chose on purpose beats the bundle, and wins over those copies too:

1. `--skill` paths and SDK `additionalSkillPaths`.
2. Entries of the `skills` setting that name a path, and skills from installed packages.
3. Project folders: `.octocode/skills/`, `.agents/skills/` and, in a trusted project, `.claude/skills/`.
4. The agent directory's own `skills/` folder (`~/.octocode/agent/skills/`, or the directory `OCTOCODE_HOME` / the SDK `agentDir` selects).
5. The bundle.
6. User-level copies in `~/.agents/skills/`, `~/.claude/skills/`, `$CODEX_HOME/skills/` and the Pi fallback folders.

To keep your own version of a bundled skill, put it in the agent directory or the project, or list its path in `skills`. Names the bundle does not ship are unaffected, and between two skills that are not bundled the first found still wins. A skipped copy appears in the collapsed skill conflicts line at startup (expand it for paths and sources). The bundled files must stay readable by the Octocode MCP server: its allowed roots include every loaded bundled skill directory. Existing symlink deduplication still applies, so an install that links to the bundled files lists them once. `--no-skills` disables automatic discovery, including the bundle; explicitly supplied skill paths still load. SDK embeddings setting `nativeFeatures: false` on `DefaultResourceLoader` do not load the Octocode bundle.

Use the existing `skills` setting to disable bundled defaults, for example `"skills": ["!octocode-roast"]`, or `"skills": ["!octocode-*"]` for the collection. These patterns also apply to matching auto-discovered skills, including the native host folders below and skill folders that extensions add. A trusted project can override a global exclusion with an exact entry such as `"skills": ["+octocode-roast/SKILL.md"]`.

Place the skill in your user or project skills directory. Directories containing `SKILL.md` are discovered recursively.

Octocode also supports the Agent Skills locations `~/.agents/skills/` and `.agents/skills/`. Project `.agents/skills/` directories are discovered from the working directory through its ancestors, stopping at the repository root when one exists. From a subdirectory of a repository, the root's `.octocode/skills/` is loaded as a project folder as well, so it keeps precedence over user skills.

Native sessions add the folders other agents use, so one install works everywhere: `~/.claude/skills/` without its `synced/` subtree, `$CODEX_HOME/skills/` (default `~/.codex/skills/`), and, after the project is trusted with `/trust`, `.claude/skills/` from the working directory up to the repository root. These host folders load after every folder above, so a same-name skill there loses with a collision warning, except that the user-level `~/.claude/skills/` and `$CODEX_HOME/skills/` copies of a bundled skill yield to the bundle (see above). `OCTOCODE_EXTRA_SKILLS=0` turns them off.

The application also ships `octocode-compact-mcp` (in `octocode/native-skills/` of the package, next to the binary in a standalone build), which guides rewriting an MCP server's generated file, its descriptions and triggers, with `octocode mcp compact`, and assigning the server to agents ([compact presentation](mcp-reference.md#compact-presentation)). A root native session discovers it whatever `OCTOCODE_EXTRA_SKILLS` says; a native subagent receives it through its parent's inventory like every other skill.

Extra user skill discovery honors `CLAUDE_CONFIG_DIR/skills` and `CODEX_HOME/skills` when those environment variables are set. Claude skills retain their description fallback, argument syntax and boolean parsing under a custom directory, including when discovery filters out the `synced/` subtree. Codex canonicalizes its selected home and requires it to exist. Missing or invalid selected homes do not fall back to another user profile; project roots and their trust checks are unchanged. These settings select local discovery paths, not vendor credentials or cloud connections.

Octocode accepts some standalone Markdown skills, but a directory containing `SKILL.md` is the portable form and should be preferred. A standalone file without a `name` is named after the file, so `deploy.md` becomes `deploy`. In a Claude skills folder, standalone Markdown needs a `description` in frontmatter: notes such as a `README.md` are not loaded. See Settings and [Octocode Packages](packages.md) for additional locations.

Project skills can instruct the model to run scripts or modify files. Review unfamiliar skills and their supporting files before granting project trust.

## Write portable frontmatter

Skill files may declare the following portable fields and invocation extensions. Informational fields remain in the file; the loader retains the name, description and invocation controls.

| Field                      | Purpose                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `name`                     | Command and display name                                                       |
| `description`              | Routing description shown to the model                                         |
| `license`                  | Informational license name or bundled license file; not enforced by the loader |
| `compatibility`            | Informational environment requirements; not checked by the loader              |
| `metadata`                 | Informational key-value metadata; not retained in the loaded skill record      |
| `allowed-tools`            | Portable experimental metadata; Octocode does not apply a permission grant     |
| `disable-model-invocation` | Omit the skill from the model’s advertised list                                |
| `user-invocable`           | Set `false` to disable user command discovery and expansion                    |

Names use lowercase letters, numbers, and hyphens, with no leading, trailing, or consecutive hyphens. They can contain at most 64 characters; descriptions can contain at most 1024.

Octocode neither requires nor warns when the declared name differs from the parent directory. Other Agent Skills implementations may enforce that requirement, so matching names remain the portable choice.

Malformed `SKILL.md` files and declared skills without descriptions are not loaded by the native and Codex readers. Skills discovered under `.claude/skills` and configured Claude plugin skills use the first non-empty body line when `description` is omitted, and accept Claude’s `yes`/`no`, `on`/`off`, and `1`/`0` boolean spellings. Claude fork/model overrides, scoped permissions and hooks, dynamic shell expansion, directory aliases, and malformed-YAML fallback remain unsupported. The loader currently drops unimplemented execution fields such as `context`, `model` and `hooks`; loading the instructions does not activate those behaviors or install a skill-scoped policy. Name collisions keep the first discovered skill and produce a warning.

## Codex supplemental policy

For a declared `SKILL.md`, the loader reads optional `agents/openai.yaml` unless the skill uses the Claude dialect. This includes individual skill paths, native/portable skill roots and configured Codex plugins. Loose Markdown commands do not load a sidecar. For a symlinked skill file, the sidecar is resolved beside its canonical target, consistent with the [pinned Codex loader](https://github.com/openai/codex/blob/8eaf5fd115f036d207be236009938261758e30f2/codex-rs/ext/skills/src/loader/host.rs#L330).

```yaml
policy:
  allow_implicit_invocation: false
```

This keeps the skill out of the model's advertised catalog while allowing explicit `/skill:name` invocation. An absent or null `allow_implicit_invocation` flag, or a value of `true`, retains default visibility. An existing `disable-model-invocation: true` remains effective even when the sidecar allows implicit invocation. Eligible resources also support [explicit Codex mentions](#select-skills-with-codex-mentions).

The loader validates the known interface, dependency and policy fields together. Malformed optional metadata produces a diagnostic and falls back to `SKILL.md` defaults; a valid policy is not partially applied from an otherwise invalid document. Diagnostics identify the file without echoing metadata values. Presentation and dependency declarations are validated but do not activate icons, default prompts, commands, servers or credentials.

Product restrictions are also applied: an empty list is unrestricted. Octocode has no Codex, ChatGPT or Atlas product identity, so a valid nonempty `policy.products` list excludes the skill from both implicit and explicit invocation, with a diagnostic. This is a local host limitation, not a claim that vendor product services are available. Explicit Claude skills ignore the Codex sidecar and retain Claude invocation behavior.

The parser is compared with retained fixtures from the pinned Codex Rust implementation. That comparison covers metadata acceptance and policy values; it does not establish full skill selection, presentation or dependency compatibility.

## Validate and share a skill

Run Octocode from a location where the skill is discoverable, then inspect the startup diagnostics and `/skills` picker. Run `/reload` after editing a skill during an active session.

Discovery does not prove that the model uses a skill. Test a realistic request without naming the skill, then inspect the tool calls and the answer:

```bash
octocode --mode json --print --no-session --no-skills \
  --skill /absolute/path/to/release-notes/SKILL.md \
  "Prepare a release note for version 2.4: it fixes duplicate invoice emails."
```

`--no-skills` suppresses automatic discovery, including extension-discovered skills, while the explicit `--skill` still loads. A `--skill` path also wins a name collision: the installed skill with that name is skipped with a collision warning. Inspect the effective skill list when evaluating an isolated skill. Use a skill appropriate to your test request and a configured model. In the JSON events, look for a completed file read of `SKILL.md`, reads of any required references, and an answer that follows the instructions. A statement that the agent will use the skill is not evidence of a successful read. Also test an unrelated request to check that it does not load the skill unnecessarily. Run each request in a fresh session and a disposable project when tools can modify files.

The initial system prompt carries skill metadata; file reads add the full instructions to conversation history. Compaction may summarize those reads, so retained skill metadata and paths allow the model to read them again. Do not assume that a skill body remains verbatim after compaction.

Use a [Octocode package](packages.md) to distribute one or more skills through npm or git. Keep environment setup inside the skill and declare any required runtime dependencies in the package.

For examples, see the [Anthropic skills collection](https://github.com/anthropics/skills).
