# Changelog

## Unreleased

- Publishable: no longer `private`, `publishConfig.access: public`, repository and keywords. It ships `src` beside `dist`, so the `source` export condition and the source maps resolve. `prepack` builds and runs `check:consumer`. `@types/node` is an optional peer.
- The declaration files import `.js` paths (`scripts/fix-dts.mjs` after `tsc`), so TypeScript 5 consumers load the types; `check:consumer --tsc <path>` typechecks with another TypeScript and passes with 5.9.
- Stricter lint for the package: oxlint's `suspicious` and `perf` rules as errors, apart from `no-unsafe-type-assertion` (untyped provider JSON).
- CI: the `agentic-testkit` GitHub workflow runs typecheck, lint, tests, build, `check:consumer` and `npm pack --dry-run` on Linux and macOS with Node 24 and 26.

- Verified against real providers (`test/live/forward-wires.live.test.ts`, `TESTKIT_LIVE=1`): Claude Code to Claude Haiku as sent, an AI SDK agent to GPT on chat completions, and Claude Code to GPT translated, each with a real tool round trip.
- `forward.body` merges model settings into every upstream request; `forwardOf` passes a tier's `body`, which it used to drop.
- An OpenAI upstream that rejects `max_tokens` for `max_completion_tokens` gets the request again with the newer parameter, and every later one of that forward with it.

## 0.2.0

- `recordMcp`: a real MCP server (stdio or Streamable HTTP) behind a recording endpoint any adapter registers. Calls land on the trace as `tool_exec` / `tool_error`, `calls()` and `summary()` measure result size, estimated tokens and latency, `defs` and `instructions` feed `analyzeSurface`, guards stop calls before the server runs them, and `transformTools` rewrites what agents see for A/B runs.
- Skills: `claudeCodeAdapter({ skills })` and `codexAdapter({ skills })` install `SKILL.md` files where each harness reads them, as `octocodecodeAdapter` already did.
- Setup and types: `…/config` with `testkitConfig()` for Vitest; `defineAdapter` (infers the run result), `runInput` and `singlePrompt` for adapter writers; the root exports `Tier` and every type tests and adapters annotate. The build emits `.js` and `.d.ts` for every module, every subpath has `default` for `require`, `sideEffects` lists the matcher registration, and `yarn check:consumer` builds a project outside the repository against `dist`.
- Examples: tested in-process adapters for the Vercel AI SDK (chat and Anthropic wires, a sub-agent), LangChain and a hand-written agent loop, importing the package by name.
- Docs: the README covers what to test, connecting an agent and adding a real model; REFERENCE holds every option and matcher; MCP-AND-SKILLS walks an MCP server and a skill through surface, contract, harness, routing and efficiency checks. `test/docs.test.ts` keeps links, anchors, imports and matcher names true to the code.
- Fixed: every reply had the same id, so LangGraph merged an answer into the earlier tool-call message; each reply now has its own. `connectMcp` pinned every call to agent `main`; it sends an identity only when given. A system turn sent as a string in one request and as text blocks in the next read as a prefix break.
- Agent lineage: a request that resends a conversation is that conversation, even with another system prompt, so a rewritten prompt is a prefix break rather than a side call; a request whose first message is a known conversation's is never a spawn; a string the parent already had (a path) never marks a task.

- Fixed: forwarding an Anthropic client (Claude Code, octocodecode on `anthropic-messages`) dropped the system prompt, blanked every tool and lost the tool calls and results. A request on the upstream's own wire now goes through as sent (model and `stream: false` aside), with the `anthropic-beta` and `anthropic-version` headers; the reply replays the upstream's blocks, so thinking signatures, Responses reasoning items and stop reasons survive. Other pairs are translated through the chat shape. New `forward.api: "responses"` for Responses clients; Gemini clients can be forwarded. Prompt-cache markers are added only to a request without its own.
- Agent lineage: the gateway infers the agent of every request without an `x-testkit-agent` header from the conversations (continuation, spawn by task text, background spawns, forks, compactions, side calls), records `spawn`, `report` and `compaction` events with `data.inferred`, and wires the `lineage` probe. `toHaveSpawned`, `toHaveHandedOff`, `toHaveNoOrphanAgents` and `toHaveCompacted` now work on Claude Code and octocodecode; `scripts()` routes by the inferred role. `agents: "header"` turns it off. The CLI adapters no longer pin every MCP call to `main`.
- Sandbox: `runProcess({ sandbox })` runs a process in a macOS Seatbelt sandbox (writes confined to the run, credential paths unreadable, network loopback-only plus an allow list); `sandboxAvailable()`. The CLI adapters sandbox by default when the gateway forwards to a real model (`GET /testkit`), and fail instead of falling back; `sandbox: false` opts out.
- Outcome grading: `snapshotWorkspace`, `diffWorkspace`, `runVerifier` (Harbor-style, with a reward file) and the matchers `toHaveWorkspace`, `toChangeOnly` and `toPassVerifier`.
- Fault steps: `stop: "max_tokens" | "refusal"`, `rawArgs` (malformed tool arguments) and `disconnect: "before-reply" | "mid-stream"`. Built-in tool failures the harness marks (Anthropic `is_error`, Gemini `response.error`) are `tool_error` events, so `toReflect` covers them. A non-streaming Responses request gets a JSON body.
- Fixed false passes: argument matching compared dates, ids and secrets masked; `times` ignored `before`; `before: "answer"` accepted another agent's answer; a trial that returned nothing passed; Vitest `retry`, `repeats`, `shuffle` or concurrency turned a failed suite turn into a pass; an edit or deletion of a `SKILL.md` counted as loading the skill. `Trial` must return a boolean.
- The judge sees tool calls and results in a `ChatMessage[]` transcript.
- Cassettes: the key covers sampling settings (`temperature`, `tool_choice`, `max_tokens`, thinking); `TESTKIT_CASSETTE_DIR` / `cassette.dir` for committed recordings, pruned never; workers merge under a file lock, and record mode keeps the current run's entries.
- Mock MCP: recursive JSON Schema validation with JSON paths, `Mcp-Session-Id` sessions, `resources` and `prompts`, `outputSchema` with `structuredContent` and `invalid-output`, JSON-RPC errors for batches and malformed JSON. `toolsFromSnapshot` keeps `outputSchema`.
- `liveCompare` / `runComparison` / `compareRates`: A/B and ablation comparisons with the Newcombe interval. `converse`, `scriptedUser`, `modelUser`: multi-turn runs with a simulated user. `yarn results --html`: a static HTML report. `analyzeSurface` flags hidden instructions in tool and skill text (`suspicious-instruction`, `SUSPICIOUS_RULES`, `findSuspicious`).
- `agentSuite(name, options, body)`: a `describe` that owns fresh agents. Each run gets its own gateway, trace, mocks and session, and each test is the next turn. It adds `runs`, a pass policy (a share, `"all"` or `"any"`), `isolation`, `concurrency`, `skip`, and `allowStop` / `fails` per test. Per-test meta and an annotation cover passes, the Wilson interval, requests, spend, tools, skills and guard stops.
- Guards: `never(pattern, when?)`, `maxToolCalls(n)`, `firstCallOnly()` and custom `(call, seen) => reason`. At the gateway a guard blocks a call before any harness sees it (built-in tools too), records a `guard` event and keeps the attempt as `model_tool_call` with `data.blocked`. At a mock MCP server it answers with an error result. New matcher: `toHaveBlocked(pattern?)`.
- Spend: `caps.pricing` prices each request (`CapturedRequest.costUsd`). `caps.maxUsd` and a suite's `budgetUsd` stop a run at a USD cap. `toStayWithin({ usd })` checks the spend. A cut request costs nothing.
- `…/reporter`: `AgentReporter` prints and writes suite pass rates, spend, mock-tool coverage (advertised tools no test executed), skills and guard stops.
- `analyzeSurface` / `surfaceOfRequest` / `toolsFromSnapshot` / `toPassSurfaceReview`: static review of tool descriptions, schemas, instructions and skills. `surfaceOfRequest` reads the tools a harness sent on any wire. `CLAUDE_CODE_LIMITS` is in `…/adapters/claude-code`.
- `probeRouting(cases, run)`: the first tool or skill a model picks per prompt, at about one request each, with accuracy and a confusion matrix.
- Matchers: tool names are exact, `*` globs or RegExps. New are `toFollowTrajectory` mode `ordered`, `toMatchSchema` (any Standard Schema, with `extractJson`), `toKeepEnvelopesUnder` (tool args, tool results including built-in tools, answers; `toolEnvelopes`), `toKeepCacheWarm` (cold reads after the first request; `cacheBreaks`) and `toHaveCompacted({ times })`.
- `wilson` and `passAtK` beside `passHatK`. `skillLoads` / `skillOf` expose the skill detection.
- The reference adapter connects `AdapterContext.mcpUrls` (it used to reject them) and keeps one conversation across runs with `conversation: true`. `AgentAdapter.unavailable()` lets suites skip; the Claude Code, Codex and octocodecode adapters implement it. `connectMcp(server, url)` and `MockMcp.defs` are exported.

- `promptShape()`: system blocks with cache markers and sections, tool prose vs schema JSON, cached prefix at each breakpoint, repeated sentences. `yarn measure` records it for every octocodecode agent; the octocodecode adapter takes `api: "anthropic-messages"`.

- `judge()` / `explainJudgement()`: grade a transcript against a rubric with a model you pass in; per-criterion verdicts and reasons.
- Fixed false passes: an async MCP handler's value was sent as `{}`; `toHaveLoadedSkill("test")` matched `test-runner`, and it missed Claude Code `Skill` and Codex `shell` loads; `.not.toHaveSpawned` and `.not.toHaveCompacted` passed with no event probe. `Trace.probes` / `trace.observe()` now record which probes are wired.
- New matchers `toFollowTrajectory` (strict, unordered, subset, superset; args subset, exact, ignore) and `toStayWithin` (requests and token limits).
- Scripted `Step` can carry text and tool calls together, `usage`, `delayMs`, or an HTTP `error` (with `retryAfterSeconds`); `script(..., { onExhausted: "fail" })`.
- `ToolDef.inputSchema` is a JSON Schema object; the mock validates `required`, `type` arrays, `integer` and `enum`.
- `runProcess` / `ProcessRun` / `writeFiles` are shared by every CLI adapter. `AgentSession.run` takes `string | RunInput` (several prompts); `AdapterContext.files`. The octocodecode adapter takes `provider`, `skills`, `settings`, `mcp`, `thinking` and `persistSession`.
- Gemini wire: `…/models/<model>:generateContent` and `:streamGenerateContent` (SSE with `?alt=sse`), with every `Step` feature; tool results link to calls by the optional call id, else by name.
- `saveResult` writes one JSON per test under `TESTKIT_RESULTS_DIR`; `yarn results [dir] [substring]` lists them, failures first, or prints one as Markdown.
- `judge({ scored: { threshold } })` gives 0–1 scores per criterion and their mean; `judgePanel({ models })` votes by majority across graders and reports their agreement.
- `passHatK` and `LiveSummary.passRate` / `passHatK` (option `k`); `judge` rejects duplicate ids and takes `instructions`; any tier name resolves from `TESTKIT_<NAME>_*`.
- The Anthropic parser keeps `tool_addition` / `tool_removal` blocks and the block structure of system messages on `ChatMessage.blocks`; the request hash ignores them.

## 0.1.0

First internal release.

- Model gateway (OpenAI chat, Anthropic messages, OpenAI Responses) with scripted replies or forwarding to a real model.
- Mock MCP servers, one trace for model and tool events, and Vitest matchers, each with a must-fail test.
- Adapters: reference loop, Claude Code, Codex, octocodecode; each behind its own subpath export.
- Run cache (cassettes): `auto`, `record`, `replay`; fingerprints, stale detection, per-trial `sample` keys and a cache report.
- Provider prompt cache markers on Anthropic forwarding, on by default.
- Model tiers (`local`, `haiku`, `deepseek`) and `live()` / `runTrials()` Bayesian statistical trials with `NoAnswer` errors kept apart from failures.
