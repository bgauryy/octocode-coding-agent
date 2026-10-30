# Context management

What a native Octocode session sends the model on each request, which parts the provider caches, and how the session keeps the history inside the context window. Details stay with their owners: [prompt caching](../packages/coding-agent/docs/prompt-caching.md), [agent instructions](../packages/coding-agent/docs/instructions.md), [MCP](../packages/coding-agent/docs/mcp.md), [`core/compaction/`](../packages/coding-agent/src/core/compaction/) and [`octocode/compaction/`](../packages/coding-agent/src/octocode/compaction/).

Diagram colors: green is cached content shared across projects, blue is cached project and session content, amber is history, purple is a mid-conversation update, red is compaction, and black is a cache breakpoint.

## What the model sees

Each request has two instruction blocks followed by the history. By default both the instruction blocks and the history are cached for one hour (`cacheRetention` and `instructionCacheRetention` in settings), so a new message never invalidates the instructions and a pause shorter than an hour keeps the history.

```mermaid
flowchart TB
    subgraph L1["Instruction block 1: same for every session with the same tools and MCP servers"]
        T["tool declarations"] --> P["preamble · tools · rules · docs"] --> M["mcp_contract_#lt;server#gt;"]
    end
    subgraph L2["Instruction block 2: project, session and role"]
        A["addendum · project_context · skills"] --> CW["cwd · environment"] --> POL["octocode_* policy · role · planning · mcp_status"]
    end
    subgraph L3["History"]
        CS["compaction summary"] --> H["messages, tool calls and results"] --> U["section updates · memory · restored files"]
    end
    M --> BP1{{"breakpoint"}} --> A
    POL --> BP2{{"breakpoint"}} --> CS
    U --> BP3{{"breakpoints: previous tail, last block"}}

    classDef b1 fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef b2 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    classDef hist fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef upd fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
    classDef cut fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    classDef bp fill:#111827,stroke:#111827,color:#ffffff
    class T,P,M b1
    class A,CW,POL b2
    class H hist
    class U upd
    class CS cut
    class BP1,BP2,BP3 bp
```

| Content                 | Source                                                                                      | Changes when                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Tool declarations       | Built-in and extension tools in their given order, then MCP tools sorted by server and name | A tool or MCP server is added or removed        |
| `preamble`              | Built-in text, or `SYSTEM.md` / a custom prompt                                             | The custom prompt changes                       |
| `tools`, `rules`        | Snippets and guidelines of the declared tools                                               | The tool selection changes                      |
| `docs`                  | Paths of Octocode's own documentation; empty for subagents                                  | Rarely                                          |
| `mcp_contract_<server>` | Each selected server's optimized TypeScript file: its instructions and typed tools          | The server's catalog changes                    |
| `addendum`              | `APPEND_SYSTEM.md`                                                                          | The file changes, then `/reload`                |
| `project_context`       | One `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md` per directory from the root to `cwd`   | A file changes, then `/reload`                  |
| `skills`                | Names, optimized descriptions and paths; bodies load on demand                              | A skill is added or removed                     |
| `cwd`, `environment`    | Working directory; platform, shell and local date                                           | A new day                                       |
| `octocode_*` policy     | `octocode/instructions/policy.ts`, adapted to the tools and to main or child agent          | The tool set or profile list changes            |
| `role`, `planning`      | The subagent's profile; the plan-mode constraint                                            | `/plan` enters or leaves                        |
| `mcp_status`            | Selected MCP servers that are not connected                                                 | A server connects                               |
| Memory                  | Pinned and query-matched notes, at most 2,400 characters, hidden from the transcript view   | Each prompt; already injected notes are skipped |
| Child task              | Identity, goal, scratch folder and teammates of a subagent                                  | Once, as the child's first message              |

Block 2 starts at the first of `addendum`, `project_context`, `skills`, `cwd` or `environment` present; `OCTOCODE_INSTRUCTION_CACHE_SPLIT=off` sends one block. An isolated subagent names the main checkout in its prompt, so sibling children share both blocks. The breakpoints shown are Anthropic's; [adapter behavior](../packages/coding-agent/docs/prompt-caching.md#behavior-and-accounting) covers other providers and [retention per layer](../packages/coding-agent/docs/prompt-caching.md#retention-per-layer) the settings. Raw `mcp.json`, commands, environment values and tokens never reach the model; server instructions and tool descriptions do.

## How a change reaches the model

Before each prompt, `before_agent_start` handlers (MCP, Octocode policy, planning, memory) fill the section inputs, and `buildSystemPromptSections` renders them. The session compares the result with the sections the transcript already holds and sends only what differs.

```mermaid
flowchart LR
    Q{"What changed?"}
    Q -->|"section text: date, plan, role, mcp_status"| SU["Section patch in the history"]
    Q -->|"tool added or removed"| TA{"Provider loads tools<br/>mid-conversation?"}
    Q -->|"model switched"| MS["Full cache miss"]
    Q -->|"idle longer than the history TTL"| IG["History rewritten"]
    TA -->|"yes"| TAM["Tool change in the history"]
    TA -->|"no"| TR["Tool list and instruction blocks rewritten"]
    SU --> OK["Instruction blocks read from cache"]
    TAM --> OK

    classDef upd fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
    classDef ok fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef bad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    classDef hist fill:#fef3c7,stroke:#d97706,color:#78350f
    class SU,TAM upd
    class OK ok
    class TR,MS bad
    class IG hist
```

Providers without mid-conversation system messages receive a section patch as a marked user message, so their leading prompt stays byte-identical. To find the cause of a miss, set `OCTOCODE_CACHE_DIAGNOSTICS=on` (Anthropic reports the first divergence) or enable `showCacheMissNotices`.

## Keeping the history small between compactions

Tool results are bounded when they are written, and old results are cleared only when the next request rewrites the history's cache entry anyway: the cache has expired, or the request carries a system update or a model switch and the context is past half its working window (`CLEAR_ABOVE_CONTEXT_SHARE`). Clearing a warm entry on its own would make the next request rewrite it. Clearing a result changes the prefix every later thinking block was bound to, so for a model that binds thinking to its prefix the request also drops the thinking of turns that follow a cleared result and were produced before it was cleared (`octocode/compaction/thinking.ts`); the provider would drop those blocks anyway, and the request no longer carries them.

```mermaid
flowchart TB
    R["Tool result"] --> B{"Over the turn's shared<br/>text budget?"}
    B -->|"yes"| SP["Saved to a file; the context keeps<br/>a bounded part and the path"]
    B -->|"no"| D{"Repeated read of an<br/>unchanged file?"}
    SP --> H["History"]
    D -->|"yes"| N["Short note pointing at the earlier result"] --> H
    D -->|"no"| H
    H --> CC{"Before a request: cache idle<br/>longer than its TTL?"}
    CC -->|"no"| SEND["Request"]
    CC -->|"yes, ≥ 20k tokens to free"| CL["Clear old results of re-fetchable tools;<br/>keep the newest 5; placeholders name saved files"] --> SEND
    SEND -->|"413 too large"| IMG["Strip images and retry"]

    classDef hist fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef cut fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    class R,H,N hist
    class SP,CL,IMG cut
```

Clearing is recorded as a session entry, so every later request applies the same placeholders and survives resume and fork. Owners: `octocode/shared/turn-budget.ts`, `octocode/files/dedupe.ts`, `octocode/compaction/clearing.ts`.

## When compaction runs

The session checks after each run and before sending a prompt; the pre-prompt check also counts the incoming prompt. `/compact [focus]` runs a manual compaction directly.

```mermaid
flowchart TB
    START(["After a run, or before a prompt"]) --> AB{"Disabled, or the response predates<br/>the latest compaction?<br/>(after a run: also aborted)"}
    AB -->|"yes"| STOP(["No compaction"])
    AB -->|"no"| OV{"Context overflow, or<br/>a recoverable length stop?"}
    OV -->|"response failed, first time this run"| RETRY["Drop the failed attempt,<br/>compact, retry the turn"]
    OV -->|"response failed again"| FAIL["Report recovery failed"]
    OV -->|"response completed"| OVK["Compact, keep the response"]
    OV -->|"no"| TH{"tokens > window − reserve?"}
    TH -->|"yes"| THR["Compact"]
    TH -->|"no"| STOP
    SW(["Switch to a model whose<br/>window is too small"]) --> DS["Compact on the previous model"]

    classDef cut fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    classDef neutral fill:#f3f4f6,stroke:#6b7280,color:#111827
    class RETRY,OVK,THR,DS,FAIL cut
    class STOP neutral
```

| Value       | Rule (`core/compaction/settings.ts`)                                                       | 200k window, thinking off |
| ----------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| Reserve     | `min(16,384, window/8)`, raised for the thinking budget plus answer room, at most window/6 | 16,384                    |
| Trigger     | context tokens > window − reserve                                                          | > 183,616                 |
| Kept recent | `min(20,000, window/4)` tokens of the newest history, verbatim                             | 20,000                    |

Automatic compaction stops after three consecutive failures for the same session and model, or when the context refilled within 3 turns of the previous compaction 3 times in a row (`octocode/compaction/pacing.ts`); a successful `/compact` resets both.

## The compaction pipeline

```mermaid
sequenceDiagram
    autonumber
    participant S as Session
    participant X as Octocode compaction
    participant P as Provider
    participant D as Disk

    S->>S: stop cache warming; choose the cut point
    S->>X: session_before_compact
    X->>X: capture messages for the archive; pick files to restore
    alt same model, not an overflow
        X->>P: the session's own request + "write a checkpoint"
    else a downshift, an overflow, or the shared request failed
        X->>P: standalone summary request, routed and cached as the session's
    end
    P-->>X: checkpoint text
    X-->>S: summary + read and modified file lists
    alt summary fits 80% of the reserve
        S->>S: keep it inline
    else session has a file
        S->>D: save it whole; keep a reference
    else in-memory session
        S->>S: keep head and tail with an omission marker
    end
    S->>S: save the compaction entry; rebuild the context
    S->>X: session_compact
    X->>D: archive the summarized messages as searchable Markdown
    X->>S: re-read up to 5 recent files
```

The cache-shared request keeps the session's system prompt, tools and thinking settings, so the provider reads the cached prefix instead of billing the whole history as new input; a cold cache does not change the choice, since the session's next request would rewrite the prefix anyway, and the summary request pays that write once. The reply is accepted when the provider's reported output tokens are within the cap (`maxTokens`); the character estimate decides only when no count was reported. The standalone request (a downshift, an overflow, a failed shared request) serializes the conversation under its own system prompt and sends the session's routing id and cache preferences; only that request saves long tool results whole and shows them as references. Both requests carry one statement of the checkpoint format (`core/compaction/summary-format.ts`: goal, constraints, progress, decisions, errors and fixes, where we stopped, critical context, TL;DR), composed into the standalone, update and branch prompts, and one focus text; a split turn sends the focus with the history request, or with the turn-prefix request when there is no history to summarize. The summary is asked only for judgment: code appends the user's messages word for word, the file lists, the saved results and the recovery pointers. Restored files get at most 20k characters each and 50k in total, capped at 10% of the window left after the reserve. Without Octocode's handler, the core's default (`core/compaction/compaction.ts`) sends a standalone request. A cut never lands on a tool result; a cut inside a turn adds a second summary of that turn's start.

```mermaid
flowchart LR
    subgraph BEFORE["Before"]
        B0["instructions"] --> B1["earlier summary"] --> B2["older messages"] --> B3["newest messages"]
    end
    subgraph AFTER["After"]
        A0["instructions"] --> A1["updated summary + file lists"] --> A3["newest messages"] --> A4["restored files"]
    end
    B0 -. "unchanged" .-> A0
    B1 -. "folded in" .-> A1
    B2 -. "summarized, archived" .-> A1
    B3 -. "kept verbatim" .-> A3

    classDef b1 fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef hist fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef cut fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    classDef upd fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
    class B0,A0 b1
    class B2,B3,A3 hist
    class B1,A1 cut
    class A4 upd
```

The compaction entry stores the system message in force, so the instruction blocks stay cached; only the history after them is written again. Summarized messages remain in the session file and in the compaction archive (`archive` tool), and memories injected before the kept range may be injected again.

Moving to another point in the session tree (`/tree`) summarizes the branch being left as a `branchSummary` message, using the same summarizer and as much of that branch as fits the window less `branchSummary.reserveTokens`.

## How skills and tools reach the context

Agents never read a skill's or MCP tool's own description directly. Every configuration change passes through one optimization stage, saved in the agent directory under `context-optimization/`, before it reaches an agent.

```mermaid
flowchart LR
    subgraph CFG["User configuration"]
        SK["Skill folders · skills setting"]
        MC["mcp.json · presets"]
    end
    subgraph OPT["context-optimization/ (saved files)"]
        SJ["skills.json · mcp/#lt;server#gt;.json<br/>user-level: shared by every project"]
        MJ["projects/#lt;repo#gt;-#lt;hash#gt;/<br/>skills.json · mcp/#lt;server#gt;.json<br/>project skills and workspace servers"]
    end
    subgraph CTX["Agent context"]
        SL["skills listing<br/>block 2"]
        CT["mcp_contract_#lt;server#gt; + thin declarations<br/>block 1"]
    end
    SK -->|"startup, /reload, skill change"| SJ
    SK --> MJ
    MC -->|"connect, catalog change"| SJ
    MC --> MJ
    MJ -->|"read first"| SL
    MJ -->|"read first"| CT
    SJ --> SL
    SJ --> CT
    SKILL["octocode-context-optimization skill<br/>rewrite · check · apply"] -.-> SJ
    SKILL -.-> MJ

    classDef b1 fill:#d1fae5,stroke:#059669,color:#064e3b
    classDef b2 fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    classDef upd fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
    class CT b1
    class SL b2
    class SKILL upd
```

- **Stored by scope, outside the repository.** User-level skills and servers share one folder across projects; a repository's own skills and workspace-defined servers get `projects/<repo>-<hash>/`, keyed by the repository so worktrees share it and two projects never overwrite each other's same-named entries.
- **Recorded automatically.** A root session records the skills it discovers, and the MCP host renders each server's file, whenever they change. Each entry keeps a hash of its source, and a rewrite applies only to the source it was written for, so an edited skill or a changed tool falls back to its own wording.
- **Rewritten by the internal skill.** New or changed entries without a rewrite are reported to the user once. The bundled `octocode-context-optimization` skill rewrites them with fidelity checks: `octocode context` for skills ([optimized descriptions](../packages/coding-agent/docs/skills.md#optimized-descriptions)) and `octocode mcp compact` for servers ([compact presentation](../packages/coding-agent/docs/mcp-reference.md#compact-presentation)).
- **Stable within a session.** Sessions read the stored text at start and `/reload`, so a rewrite never changes a cached prompt mid-run. Subagents read the same store.

An MCP server reaches an agent only when the agent's tool selection names it. A server with `defaultActive: false`, such as the built-in `browser`, starts only for agents whose selection names `mcp__<server>__*`; a selected server that has not connected yet is named in `mcp_status`. File locations and precedence are in the [MCP reference](../packages/coding-agent/docs/mcp-reference.md#configuration-and-precedence); `/mcp config` shows what the current session resolved.
