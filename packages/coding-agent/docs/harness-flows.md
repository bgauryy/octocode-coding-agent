# How Octocode builds a request, and what keeps it small

Every model request is assembled from the same parts. This page follows them in order and names, for each saving, what it buys, what it costs and the setting that controls it. Provider cache details are in [prompt caching](prompt-caching.md); the source of each part is in [what an agent reads](agent-context.md).

```mermaid
flowchart LR
    A["Request assembly"] --> B["Fixed prefix<br/>for the prompt cache"]
    B --> C["Tool loadout<br/>direct, deferred, onDemand, hidden"]
    C --> D["Trimming history<br/>clearing, compaction"]
    D --> E["Outside data<br/>fenced and checked"]
```

| Optimization         | Saves                                             | Costs                                                      | Controlled by                                                         |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Fixed prefix, cache  | Re-billing the unchanged start at full price      | Changes wait for a new session or a one-time rewrite       | `cacheRetention`, `cacheWarming`, [prompt caching](prompt-caching.md) |
| Deferred tools       | Tokens of descriptions and schemas you do not use | One extra call to read a schema                            | `mcpExposure`, `exposure`, `toolExposure`, `nativeToolExposure`       |
| Clearing old results | Re-sending large old tool output                  | A rewrite of the cached history once; saved copies on disk | None (always on)                                                      |
| Compaction           | Overflowing the window                            | A summary request; detail is lossy but archived            | `contextBudget`                                                       |
| Fencing outside data | Injected instructions reaching the model          | A few tokens of fence per fenced result                    | None (always on)                                                      |

## 1. Request assembly

A request is the tool declarations, the system prompt in up to three blocks, then the history. Order matters: the provider can reuse only an identical start.

```mermaid
flowchart TD
    T["Tool declarations<br/>built-in, then MCP tools by server and name, then role tools"] --> B1
    B1["Block 1: base<br/>preamble, tool lines and rules, docs, MCP server blocks"] --> B2
    B2["Block 2: session<br/>policy, project instructions, skills listing, hooks, role"] --> B3
    B3["Block 3: volatile<br/>directory, date and platform, plan mode, MCP status"] --> H
    H["History<br/>checkpoint, messages, tool results, notices, memory"]
```

| Part                   | What it holds                                                                                                           | You change it with                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| System prompt          | Built-in text, the policy for the declared tools, your `SYSTEM.md` or `APPEND_SYSTEM.md`                                | [Instructions](prompts.md)                                  |
| Instruction files      | `AGENTS.md` files from the global one down to the working folder; deeper ones load when a file under them is first read | `--no-context-files`                                        |
| Skills listing         | Each skill's name, description and path; the body loads only when the agent calls `skill`                               | `/harness` per skill; [skills](skills.md)                   |
| MCP instruction blocks | One block per enabled server: its purpose, call prefix and instructions (deferred tools add one index line each)        | `/settings enable` or `disable` `mcp:<name>`, [MCP](mcp.md) |
| Tool declarations      | One declaration per tool: native tools in full, MCP tools by their exposure                                             | [Tool loadout](#3-tool-loadout)                             |
| History                | The latest checkpoint, recent messages, tool calls and results, memory and backlog notices                              | [Trimming context](#4-trimming-context)                     |

Block 3 is sent without a cache boundary, so a new day or a changed MCP status does not rewrite the two cached blocks above it. A session saved by an older version keeps its stored order. Block layout and the full section list: [Context management](../../../docs/CONTEXT.md#what-the-model-sees); per-adapter boundaries: [second instruction block](prompt-caching.md#second-instruction-block).

## 2. Prompt cache: a fixed prefix

The cache can reuse the start of a request only while it is byte-identical. Octocode therefore treats the tool list and instruction blocks as fixed for the session and moves changes somewhere cheaper.

```mermaid
flowchart TD
    S["Session starts"] --> L["Tool list and MCP blocks fixed"]
    L --> C{"Something changes"}
    C -- "date, plan mode, MCP status" --> V["Volatile block only"]
    C -- "a deferred tool is called" --> R{"Model replaces tools in place?"}
    R -- yes --> I["Full declaration added once,<br/>prefix untouched"]
    R -- no --> T["Stays thin; schema arrives<br/>as a tool result"]
    C -- "server catalog changes" --> P["Re-registered or patched once"]
    C -- "model change, new session, branch" --> N["Loadout rebuilt, new prefix"]
```

| Mechanism                            | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Saves                                     | Costs                                                                                                                  | Setting                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Tool list fixed per session          | Which tools are direct, deferred or on demand is decided when the session starts and kept; the set of tools in use is saved with the first prompt, so resume, reload and fork declare the same set                                                                                                                                                                                                                                                                                                                                         | A prefix rewrite on every change          | A tool you start using mid-session keeps its starting state; its first call declares it in full where the model allows | `mcpExposure` (and pins)                             |
| Redeclared in place after first use  | After its first call (successful or not), a deferred MCP tool is declared in full for the rest of the session, but only where the model accepts in-place tool changes (Anthropic with mid-conversation tool changes, OpenAI Responses with additional tools). The prefix is not rewritten, and compaction keeps the declaration                                                                                                                                                                                                            | Re-reading the schema on every later call | Nothing on those models; elsewhere the tool stays thin and its schema keeps arriving as a tool result                  | `mcpPresentation` must be `declared` (default)       |
| Children share the parent's tool set | A subagent uses its parent's set of tools in use, so siblings declare the same tools and share the cached tool prefix; tools that depend on the agent's role come last and do not follow it: `memory`, `archive`, `models` and `backlogPlan` are declared deferred in a child, or left on demand (`memory`, `archive`, `models`) where the model allows. A child without a role, like the bundled `implementer` and `reviewer`, defers its read-only MCP tools; a profile with `mcpDefer` shares only with agents that defer the same ones | Each child re-writing the same prefix     | A child's MCP tools follow the parent's use, not its own                                                               | Agent profile `mcpDefer`                             |
| Cache warmer                         | Between turns Octocode may send a cheap refresh so the cached history does not expire, when its expected saving reaches $0.05, or while it waits on children, jobs, timers or an asked answer, up to one rewrite's cost per wait                                                                                                                                                                                                                                                                                                           | A full re-write after a pause             | The refresh requests, billed as reads                                                                                  | `cacheWarming`: `off`, `streaming`, `idle` (default) |

Catalog changes (an MCP server changing a tool's description or schema) re-register that tool once; a reconnect with the same catalog changes nothing ([the table](prompt-caching.md#second-instruction-block)). On the Anthropic API Octocode asks the provider why each request missed the cache, unless `OCTOCODE_CACHE_DIAGNOSTICS=off`; `showCacheMissNotices` names the reasons in the transcript ([miss reasons](prompt-caching.md#provider-reported-miss-reasons)); the warmer's arithmetic and window are in [warming and measurements](prompt-caching.md#warming-and-measurements).

## 3. Tool loadout

A tool is declared to the model in one of four states ([what each gives the model](configuration.md#tool-exposure)).

| State      | Model sees                                                                                                                                                                                                  | Reads the schema through                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `direct`   | Whole description and full schema                                                                                                                                                                           | The declaration                                                                                                          |
| `deferred` | The tool's whole description, its field names with JSON types (up to 32 names per nested object), the few values a field allows, list bounds and required fields, plus one index line in its server's block | A rejected call, or the `mcp` tool with intent `tools`                                                                   |
| `onDemand` | Not declared: one line with its name and trigger in its server's block or the tool list                                                                                                                     | Its first call, or the `mcp` tool with intent `tools`; either declares it from the next request, after the cached prefix |
| `hidden`   | Nothing; the tool cannot be called                                                                                                                                                                          | Not available                                                                                                            |

A deferred tool stays callable and every call is still validated against the server's full schema. Only the schema detail (descriptions of fields, long value lists, deeper fields) is deferred: the field names, short value lists and required fields let the model write a correct first call, and a wrong call returns the full schema. An agent without the `mcp` tool gets nothing deferred and nothing on demand.

### Two layers of tools

```mermaid
flowchart TD
    subgraph Cached["Cached layer: fixed at session start"]
        L["Tool list in a deterministic order<br/>direct tools in full, deferred tools thin"]
    end
    subgraph Dynamic["Dynamic layer: loaded when needed"]
        D["A deferred tool, MCP or native"]
    end
    D --> W{"How it is loaded"}
    W -- "mcp tools<br/>(server native for a native tool)" --> X["Full schema"]
    W -- "refused call" --> X
    W -- "first call" --> X
    X --> T{"Transport changes tools in place?<br/>Anthropic tool_addition,<br/>OpenAI Responses additional_tools"}
    T -- yes --> R["Redeclared in full once,<br/>after the cache breakpoint"]
    T -- no --> S["Stays thin; schema arrives<br/>as a tool result"]
    R -.-> L
    S -.-> L
```

| Layer   | Holds                                                                | Changes                                                                                                        |
| ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Cached  | The tool list and server blocks, in the same order for every session | Only at session start, a model change, tree navigation or a catalog change                                     |
| Dynamic | Full definitions of deferred tools the session needed                | Appended once per tool, after the cache breakpoint, where the transport allows; otherwise only as tool results |

A deferred MCP tool is declared in full after its first call, successful or not. A deferred native tool is declared in full after being read with `mcp` (`intent: "tools"`, `server: "native"`, the tool's name), after a refused call, or after its first call. A compaction summarizes loaded schemas away, so the schemas of deferred tools the session called come back in one hidden message (within a size budget). Details: [exposure and results](mcp-reference.md#exposure-and-results).

### Choosing the state

```mermaid
flowchart TD
    Q["Tool"] --> P1{"Pin?<br/>toolExposure, nativeToolExposure"}
    P1 -- yes --> R1["pinned state"]
    P1 -- no --> P2{"Server exposure?"}
    P2 -- yes --> R2["server state"]
    P2 -- no --> M{"mcpExposure"}
    M -- direct --> D["direct"]
    M -- "deferred, usage" --> F["deferred"]
    M -- recent --> U{"Called in this folder<br/>in the last 24 hours?"}
    U -- yes --> D
    U -- no --> F
    M -- "auto:bytes" --> A{"Server blocks fit the budget so far?"}
    A -- yes --> D
    A -- no --> F
    R1 -- onDemand --> O{"Model adds tools in place,<br/>tool not in use?"}
    R2 -- onDemand --> O
    O -- yes --> OD["onDemand"]
    O -- no --> F
```

| `mcpExposure`       | A tool without a pin is                                                                                                                    | Saves                                         | Costs                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `"recent"`          | `direct` if this working directory called it in the last 24 hours, else `deferred`                                                         | Most unused descriptions and schemas          | A first call to a rarely used tool may be refused once for its schema                             |
| `"usage"` (default) | `deferred`, used or not; an on-demand tool the promotion snapshot names is declared `deferred` from the start instead of at its first call | The same; on-demand tools stay out until used | The same first-call cost; a new install has no data, so on-demand tools wait for their first call |
| `"direct"`          | `direct`                                                                                                                                   | Nothing                                       | Every description and schema in every request                                                     |
| `"deferred"`        | `deferred`                                                                                                                                 | The most                                      | The same first-call cost for every tool                                                           |
| `"auto:<bytes>"`    | `direct` for servers in name order while their text fits the byte budget, then `deferred`                                                  | A fixed ceiling, whatever the model's window  | Which servers are direct depends on name order, not on use                                        |

The `auto` budget counts bytes, not a share of the context window, so changing models never changes the loadout.

A tool its configuration puts on demand (`onDemand`) is left undeclared only where that pays:

| Case                                                                                                         | The tool is                                                          |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| The model cannot add a tool after the cached prompt, or the agent has no `mcp` tool                          | `deferred` from the start                                            |
| In the session's set of tools in use: the promotion snapshot under `"usage"`, recent use under `"recent"`    | `deferred` from the start under `"usage"`, `direct` under `"recent"` |
| An MCP tool named exactly in the agent's `--tools` list (a pattern such as `mcp__browser__*` does not count) | `deferred` from the start                                            |
| Otherwise                                                                                                    | `onDemand` until its first call or a read with `mcp`                 |

`archive`, `models` and `configuration`, and `memory` in a subagent, are on demand whenever they would be `deferred` and no `nativeToolExposure` pin names them.

### Usage-based promotion

`"usage"` declares every deferrable tool thin, however often sessions use it: no tool is promoted to a full declaration. Use decides only when an on-demand tool is declared: one the snapshot names is `deferred` from the session's start, any other waits for its first call.

| Rule                 | Value                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Counts               | Per tool and per role group (main, subagent): sessions that declared it, called it, read its description, and calls its schema refused. Kept for 7 days across all folders                                                                                  |
| Promoted by use      | At least 10% of declaring sessions called or read it, and at least 20 sessions of that group declared it; a tool with fewer sessions keeps its configured exposure                                                                                          |
| Promoted by refusals | Refused calls exceed one per session that used the tool                                                                                                                                                                                                     |
| Budget               | The promoted tools' thin declarations, most used first, fit `mcpPromotedBytes` (8,192 bytes per role group by default)                                                                                                                                      |
| Snapshot             | Each group computes one per UTC day and installed version, at the first session start that needs it; the session, its resumptions and its subagents keep it                                                                                                 |
| Native tools         | `memory` and `notify` are deferrable only under `"usage"` or a pin; `archive`, `models`, `backlogPlan` and `configuration` follow `recent` and `usage`; `archive`, `models` and `configuration` (and `memory` in a subagent) are the native on-demand tools |
| No data              | Nothing is promoted: on-demand tools wait for their first call. Deleting the counts file has the same effect                                                                                                                                                |

`"usage"` is the default. A tool sessions use often still sends only its thin declaration; its full schema arrives after its first call, in place where the model allows. Counts are a hint: an unreadable file reads as no data.

**Usage audit.** Three places show the same numbers per tool: the **Use (7 days)** column of the Tools panel on the [web Settings page](web-workspace.md#settings-page), the `/mcp` → server → **Tools** page, and the `mcp` tool's `tools` listing. Each row shows the share of sessions that used the tool, its calls, the last day used (or "unused in 7 days"), refusals, and for a deferred tool the bytes its thin declaration saves. Under `"usage"` the row also gives the reason: `promoted` (an on-demand tool the snapshot declares from the session's start) or `unused` (deferred and never used in the window).

### Pins

| Pin                  | Where                                                          | Applies to                                                                                           |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `toolExposure`       | The server's entry in `mcp.json` (exact names or `*` patterns) | One MCP tool                                                                                         |
| `exposure`           | The server's entry in `mcp.json`                               | Every tool of the server without its own pin                                                         |
| `nativeToolExposure` | `settings.json`, for deferrable native tools                   | `direct` or `deferred`; unpinned they follow `mcpExposure`. Every other native tool is always direct |

Pins and `mcpExposure` apply from the next session. See and change them in the Tools panel, or in `/mcp`, then the server, **Tools** › **Default for tools**. Reference: [MCP tool exposure](mcp.md#control-tool-exposure).

## 4. Trimming context

Two mechanisms keep the history inside the window. Clearing is cheap and frequent; compaction is the last resort.

```mermaid
flowchart TD
    R["Before each request"] --> W{"Cache rewritten anyway?"}
    W -- yes --> F{"Old results and file payloads<br/>total at least 4,000 tokens?"}
    W -- no --> O{"At least 20,000 tokens, and re-sending<br/>costs more than one rewrite?"}
    F -- no --> K["Keep as is"]
    O -- no --> K
    F -- yes --> S["Results: saved to a file, replaced by a placeholder<br/>with a digest. File payloads: size and hash.<br/>(newest 5 of each stay)"]
    O -- yes --> S
    S --> X{"Context over window minus reserve?"}
    K --> X
    X -- yes --> C["Compact: summary replaces older history"]
    X -- no --> Z["Send"]
    C --> Z
```

### Clearing old tool results

Only results that can be fetched again are cleared: `web`, MCP tools and `bash` commands that only print (reads, `sed -n` and `awk` that write nothing, also after `cd` or in a pipeline). `agent` results, `file` results and writing commands never are. Each cleared result's full text is saved first and the placeholder names the file, so nothing is lost; one that cannot be saved stays. The placeholder adds a one-line digest: the result's line count, a command's exit code, and for a result from your own workspace the search hits by file; an outside result (a web page, an MCP server's text, a network command) gets counts only, none of its text.

The payload of an old `file` change (written content, edit texts or a patch of at least 1,000 characters) is cleared too: the change is on disk, so each long string becomes its size and the start of its SHA-256, and the agent reads the file for its current text.

Clearing needs the old results and payloads to total at least 4,000 tokens where the cache is rewritten anyway, or 20,000 while it is warm; the newest five results and the newest five `file` changes always stay. Results still in use stay too: every one called in the last ten turns, whatever its size, and older ones whose file path a message of those turns names, up to 20,000 tokens, newest first. In plain words:

- **Free:** if the next request would rewrite the cache anyway (the cache expired, a compaction replaced the history, the model changed, or an update rewrites the start), clearing costs nothing extra, so everything old goes at once.
- **While the cache is warm:** clearing makes the next request write the changed history to the cache once, which costs more than reading it. It happens only when re-sending the old results for the requests still expected would cost more than that one rewrite; it may then clear only the results after a large message that stays, when that saves more. Expected requests are about as many as the session has made since the last compaction, capped by how many fit before the compaction threshold, and lowered when this session's earlier clearings were followed by fewer requests than expected.
- **Unknown cache lifetime:** only the free case clears.

The decision is stored with the session, so later requests, a resume and a fork show the same placeholders and the prefix stays byte-stable. Details and the formula: [clearing old tool results](native-features.md#clearing-old-tool-results). There is no setting for it.

**Clearing ledger.** The profiler lists each clearing wave as a finding: the tokens it freed, the tokens the next request wrote, the requests until the next compaction, and its net cost or saving (when the model lists prices). Waves that ran because the cache was rewritten anyway are listed apart, one finding per agent, since they added no write.

### Compaction

When context tokens exceed the window minus a reserve, Octocode summarizes older history into a checkpoint and keeps the newest messages verbatim.

| Part     | Rule                                                                                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window   | `contextBudget` (default 300,000 tokens), capped at 90% of the model's capacity; `"full"` uses all of it                                                                                                                                                              |
| Trigger  | Context above the window minus the reserve: 24,576 tokens, so the summary fits inside the cached request (an eighth of small windows), raised for the thinking budget, at most a sixth of the window. A 200,000-token window compacts above 175,424 with thinking off |
| Kept     | Up to 20,000 recent tokens (a quarter of smaller windows), word for word                                                                                                                                                                                              |
| Manual   | `/compact [focus]`                                                                                                                                                                                                                                                    |
| Agent    | The `compact` tool, at a task boundary once a context notice says automatic compaction is near (from 90% of the room before it); refused below that. It can take the summary written ahead; its focus then follows the summary, labelled as the agent's               |
| Counting | Provider receipts where they apply; new content, tools and images are estimated at 2.5 characters per token for Claude (and any model of unknown family), 3.3 for DeepSeek models, 3.5 for OpenAI models                                                              |
| Setting  | Automatic compaction is always on and has no switch; only `contextBudget` moves the trigger                                                                                                                                                                           |

What survives, and where else to find the rest:

| Kept in context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Left to the saved archive                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The checkpoint (goal, progress, next steps; standing constraints and key decisions carried word for word with ids such as `[C3]` until the summary marks one lifted or superseded); your messages and `askUser` answers word for word within a budget; file lists and saved results; a Recovery section of about 800 characters pointing to the archive and transcript; the bodies of the two skills loaded most recently (5,000 tokens each, 10,000 in all), others by name; the backlog and running work as the tools report them now; schemas of deferred tools the session called; up to five files the agent changed, re-read whole (an outline or a window when long); files only read are named, not re-read; never Octocode's own files under `.octocode/` (a worktree there still counts as work) | Summarized messages, as searchable Markdown for the `archive` tool; the session file keeps every original entry |

The cost is a summary request (shared with the cached prefix when the model is unchanged) and a lossy summary. The pipeline and its limits: [Context management](../../../docs/CONTEXT.md#the-compaction-pipeline); rules and caps: [Compaction](configuration.md#compaction).

## 5. Outside data

Text written by someone other than you can carry instructions aimed at the model. Octocode marks it and checks it before it can drive an action.

```mermaid
flowchart LR
    W["Web page, MCP result or resource,<br/>network command output"] --> F["Fenced as data<br/>with its origin"]
    F --> M["Model"]
    M --> Q{"Next call repeats that text<br/>in a command, file write,<br/>MCP call or task?"}
    Q -- yes --> A["Asks you first<br/>(recorded in full mode)"]
    Q -- no --> G["Runs under normal permissions"]
```

The origin is decided by where the result came from (the tool's source and what ran), never by a field a tool declares about itself, because MCP definitions come from external servers. The fence and the provenance check share this one rule.

| Result                                                                                                             | Fenced? | Why                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------- |
| `web` pages and search snippets                                                                                    | Yes     | Anyone can publish them                                                       |
| MCP tool results                                                                                                   | Yes     | The server, or what it fetched, may be third-party                            |
| Resources read with the `mcp` tool (`read`); its other intents report Octocode's own state, so they are not fenced | Yes     | The resource is the server's text as it wrote it                              |
| Output of network commands such as `curl` and `ssh` that ran                                                       | Yes     | It is remote text                                                             |
| Reads and searches your trusted MCP entries declare as `reader` or `search` over your workspace                    | No      | It is the repository you asked about; a fence would cost tokens on every read |
| `file`, local commands, a refused or blocked call                                                                  | No      | Not outside text                                                              |

The fence names the origin (the URL, query, tool or command) and says the content is data. It is added only when the request is built, so the session, terminal and saved text stay as the tool returned them. The marker is a hash of the text, so the same result fences to the same bytes every time and the cached prefix is kept. A result already replaced by a clearing placeholder is not fenced.

The provenance check is separate: text from untrusted sources (MCP results and resource reads, network command output, a subagent's report) that reappears in a consequential argument (a shell command, file content, an MCP call, a memory, a subagent's task) asks before it runs, in `manual` and `workspace` modes; `full` runs and records it. It matches text, so paraphrase or encoding defeats it: a tripwire, not a sandbox. Sources, limits and modes: [Provenance](permissions.md#provenance).

## 6. Caching across providers, forks and children

How each provider is asked to cache decides what a change costs. Provider settings, lifetimes and warming are in [prompt caching](prompt-caching.md).

| Provider               | What Octocode sends                                                                                        | Routing                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Anthropic              | Up to four explicit cache markers: tools, instruction blocks, the last message and the previous tail       | Session-affinity header on gateways that take one        |
| OpenAI Responses       | A cache key; 24-hour retention or explicit mode on models that support them                                | `x-client-request-id` carries the key                    |
| Codex                  | A cache key                                                                                                | `session-id` and `x-client-request-id` carry the key     |
| OpenRouter and similar | A cache key where the model allows it; Anthropic-style markers on models that need them                    | `x-session-id` carries the key                           |
| xAI                    | The Responses cache key                                                                                    | `x-grok-conv-id` and `x-client-request-id` carry the key |
| Google and Vertex      | Nothing: the provider caches a stable prefix implicitly, so keeping the prefix identical is the only lever | None                                                     |

What each event does to the cached request, per provider. "Kept" means the request opens with the previous one, so the cached part is read again; "rewritten once" means the history is billed again once and the next request appends.

| Event                         | Anthropic                                         | OpenAI Responses | Codex          | OpenRouter        | xAI            | Google, Vertex    |
| ----------------------------- | ------------------------------------------------- | ---------------- | -------------- | ----------------- | -------------- | ----------------- |
| Next turn                     | Kept                                              | Kept             | Kept           | Kept              | Kept           | Kept              |
| Deferred tool loaded          | Kept                                              | Kept             | Kept           | Kept: tool result | Kept           | Kept: tool result |
| Refused call returns a schema | Kept                                              | Kept             | Kept           | Kept              | Kept           | Kept              |
| Skill loaded                  | Kept                                              | Kept             | Kept           | Kept              | Kept           | Kept              |
| Images in history             | Kept                                              | Kept             | Kept           | Kept              | Kept           | Kept              |
| Fork                          | Kept                                              | Kept             | Kept           | Kept              | Kept           | Kept              |
| Child agent                   | Kept: tools, instructions and marker places match | Kept             | Kept           | Kept              | Kept           | Kept              |
| Model switch                  | Rewritten once                                    | Rewritten once   | Rewritten once | Rewritten once    | Rewritten once | Rewritten once    |
| Provider switch               | Rewritten once                                    | Rewritten once   | Rewritten once | Rewritten once    | Rewritten once | Rewritten once    |
| Compaction                    | Rewritten once, tools and instructions kept       | Same             | Same           | Same              | Same           | Same              |

No event rewrites the request on every turn. Two notes on reading it: the deferred-tool row says "kept" for every provider because loading never changes the tools that were sent: a model whose catalog entry allows in-place tool changes (Anthropic tool changes, OpenAI Responses and Codex additional tools, which xAI's endpoint can also carry) gets the definition appended after the breakpoint, and any other model gets the schema as a tool result; the table shows what the request bytes do, and a provider's own routing, minimum length and expiry still decide a real hit.

### Forks and children share the parent's cache

```mermaid
flowchart TD
    P["Parent session<br/>cache key = its id"] --> FK["Fork"]
    P --> CH["Child agents"]
    FK --> K1["Uses the first session of the fork chain as the key<br/>request body and routing headers match the parent's"]
    CH --> K2["Siblings share one key<br/>same tools, instructions and marker places"]
    K1 --> H["Same replica, same cached prefix"]
    K2 --> H
    K2 -.-> M["Mistral: siblings keep their own affinity;<br/>a fork pins to its parent's"]
```

A fork sends its parent's request byte for byte, and the routing headers above carry the parent's key, so the fork lands where the parent's prefix is cached. Children of one parent and profile build the same tools and instruction blocks and share one key, so a second child reads what the first wrote. Each child keeps its own transcript and cancellation. On Mistral a fork pins to its parent's replica, but sibling children keep their own affinity. Disabling caching omits the key and the routing headers.
