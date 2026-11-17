# agentic-testkit

Vitest-native behavior tests for agent harnesses: scripted model replies, mock MCP servers, a recorded trace of one run and matchers over that trace. It knows no harness: a harness plugs in through a small adapter. Status: 0.1.0, internal (not published); see [CHANGELOG](CHANGELOG.md).

## Install and entry points

Requires Node 24.15+ and Vitest 5. Inside this repository, add `"@octocodeai/octocode-agentic-testkit": "workspace:*"`; Vitest resolves the TypeScript source, plain Node the built `dist/` (`yarn build`).

| Import                                                 | Gives                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `@octocodeai/octocode-agentic-testkit`                 | gateway, trace, MCP mocks, memory, `live()`, matchers, reference loop |
| `@octocodeai/octocode-agentic-testkit/setup`           | registers the matchers (Vitest `setupFiles`)                          |
| `@octocodeai/octocode-agentic-testkit/cache-report`    | run-cache summary (Vitest `globalSetup`)                              |
| `@octocodeai/octocode-agentic-testkit/tiers`           | named model tiers                                                     |
| `@octocodeai/octocode-agentic-testkit/adapters/<name>` | `reference`, `claude-code`, `codex`, `octocodecode`                   |

New here? Read the [developer guide](GUIDE.md) for the workflow: running suites, writing a test, tiers, caching and adapters.

## What you can test

| Area                  | Example question                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Agent flow            | Did it call the tool, with these args, before answering? Did it retry the failed call unchanged? |
| Triggers              | Did the skill load for this prompt? Did it stay unloaded for that one?                           |
| MCP                   | Which tools did the server execute, with what args, and what did it fail with?                   |
| Multi-agent           | Was a child spawned, did it report back, is any child orphaned?                                  |
| Caching and context   | Is the request prefix byte-stable? Is there duplicate text? How fast does the history grow?      |
| Memory and compaction | Was a fact recalled before acting? Did compaction happen?                                        |

## Three probes

The testkit never reaches into the harness. It stands where the harness already talks to the outside.

| Probe         | How the harness reaches it                                                                                | Gives you                                                                                             | Required |
| ------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| Model gateway | Point the harness's model base URL at `gateway.url` (OpenAI chat-completions or Anthropic messages shape) | Every request (messages, tools, usage) and the scripted tool calls and answers                        | yes      |
| MCP mock      | Register `mock.listen()` as an HTTP MCP server                                                            | Server-side `tool_exec` / `tool_error` events, per-tool `vi.fn` spies, injected failures and timeouts | no       |
| Events        | The harness (or its adapter) calls `trace.record(...)`                                                    | `skill_load`, `spawn`, `report`, `memory_*`, `compaction`                                             | no       |

All three write to one `Trace`. A matcher that needs a probe you did not wire fails with `cannot observe: <what>` instead of passing.

## Quickstart

```ts
import { expect, it } from "vitest";
import { startGateway, script, mockMcp, referenceAdapter } from "../src/index.ts"; // matchers register via setupFiles

it("searches before answering", async () => {
	const gw = await startGateway({
		responder: script([{ toolCalls: [{ name: "search", args: { query: "cache" } }] }, { text: "done" }]),
	});
	const docs = mockMcp({
		name: "docs",
		trace: gw.trace,
		tools: [
			{
				name: "search",
				description: "Search",
				inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
			},
		],
	});
	const session = await referenceAdapter({ trace: gw.trace, mcp: [docs.client()] }).start({ gatewayUrl: gw.url });
	await session.run("find the cache docs");
	expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache" }, before: "answer" });
	await session.close();
	await docs.close();
	await gw.close();
});
```

Run: `vitest run` (config: `pool: "forks"`, real timers, `setupFiles: ["./src/setup.ts"]`).

## Adapters

An adapter is the only code that knows how a harness is configured.

```ts
interface AgentAdapter<R = unknown> {
	name: string;
	start(ctx: {
		gatewayUrl: string;
		mcpUrls?: Record<string, string>;
		workdir?: string;
		env?: Record<string, string>;
	}): Promise<{ run(prompt: string): Promise<R>; close(): Promise<void> }>;
}
```

| Adapter                                      | Status | How it connects                                                                                                                                                                                                                                              |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reference` (`src/adapters/reference`)       | works  | In-process tool loop (skills, memory, spawn, compaction); MCP clients passed as options, not `mcpUrls`; emits every event kind                                                                                                                               |
| `octocodecode` (`src/adapters/octocodecode`) | works  | Spawns the built CLI in a temp HOME with `models.json` (gateway) and `mcp.json` (mock URLs); bundle path from `bundle` option or `TESTKIT_OCTOCODECODE_BUNDLE`; `parseSkillListing` reads its skill prompt                                                   |
| `claude-code` (`src/adapters/claude-code`)   | works  | Spawns `claude -p … --output-format stream-json --verbose --strict-mcp-config --mcp-config <file>` with `ANTHROPIC_BASE_URL` at the gateway, a dummy key and a temp HOME/`CLAUDE_CONFIG_DIR`; mock MCP tools sit behind `ToolSearch` but stay callable       |
| `codex` (`src/adapters/codex`)               | works  | Temp HOME/`CODEX_HOME` `config.toml`: `mock` provider (`wire_api = "responses"`, websockets off), `[mcp_servers.*]` with `default_tools_approval_mode = "approve"`, dead `HTTPS_PROXY` (Codex ignores `OPENAI_BASE_URL`); tool calls use `{namespace, name}` |

Write one in four steps:

1. Create an isolated HOME and workdir; never touch the real one.
2. Write the harness's config so its model URL is `ctx.gatewayUrl` and its MCP servers are `ctx.mcpUrls`.
3. `run(prompt)` starts the harness with `ctx.env` and returns what you can report (exit code, output).
4. `close()` kills the process group and removes the temp directories.

Core code (everything outside `src/adapters`) must not mention a harness; `test/decoupling.test.ts` enforces it.

## Matchers

All matchers take a `Trace` (`gw.trace`). "Cannot observe" always throws `cannot observe: ...`, also under `.not`, so missing data is never a pass.

| Matcher                                         | Observes                                                     | Fails when                                                  | Cannot observe when                                             |
| ----------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `toHaveCalledTool(name, {args, before, times})` | model tool calls                                             | not called, args differ, count differs, call after `before` | empty trace; `before` target absent                             |
| `toHaveCalledMcp(server, tool, opts)`           | server-side executions                                       | tool not executed (or args/count/order differ)              | no events from that server                                      |
| `toHaveLoadedSkill(name)`                       | `skill_load`, `skill` calls, `SKILL.md` reads                | not loaded                                                  | no events                                                       |
| `toKeepStablePrefix()`                          | request prefixes (messages, tools, model)                    | a request rewrites an earlier one                           | fewer than two requests                                         |
| `toHaveNoDuplicateBlocks()`                     | repeated large blocks                                        | a block repeats                                             | no requests                                                     |
| `toGrowAtMost(bytes)`                           | request size per agent                                       | a turn grows more than `bytes`                              | no agent has two requests                                       |
| `toHaveCacheReadRatio({min})`                   | usage (reported or estimated)                                | ratio below `min`                                           | no usage on any request                                         |
| `toNotRetryIdentically(tool)`                   | tool errors and model calls (raw or `mcp__<server>__<tool>`) | same args re-sent after an error                            | no error for the tool; no model calls; no call before the error |
| `toReflect({after: "error"})`                   | next action after a tool error                               | model answers without another tool call                     | no tool error; no action after it (unless the trace was cut)    |
| `toHaveSpawned(role, {times})`                  | `spawn` events                                               | role not spawned, count differs                             | no spawn events and no spans                                    |
| `toHaveNoOrphanAgents()`                        | child spans and `report`                                     | a child never reported                                      | no child spans                                                  |
| `toHaveHandedOff(from, to)`                     | `spawn` and `report`                                         | not spawned or no report back                               | no spawn events                                                 |
| `toHaveRecalledBefore(key, tool)`               | `memory_*` events and the tool call                          | key not read before the call                                | no memory events; tool never called                             |
| `toHaveCompacted()`                             | `compaction` events                                          | none                                                        | empty trace                                                     |

Each matcher has a negative case in `test/matchers.negative.test.ts`.

## Grading an answer: `judge()`

Behavior goes through matchers; the wording of an answer needs a grader. `judge({ rubric, transcript, model })` sends the rubric and the transcript to a model you pass in (a resolved tier, or any `{ baseUrl, model, api: "openai" | "anthropic", key }` endpoint) and returns one verdict with a reason per criterion. `pass` is true only when every criterion passes. A criterion the judge skips fails; a reply that is not the requested JSON throws, so a broken judge is never a pass. The judge call is not cached by the run cache and sends no prompt-cache markers.

```ts
const j = await judge({
	rubric: [{ id: "cites-file", text: "Names the file that holds the fix" }],
	transcript: answerText, // or chat messages
	model: tier, // from resolveTier()
});
expect(j.pass, explainJudgement(j)).toBe(true);
```

Judge verdicts are model output: use a paid or local tier for the grader, and run them as a rate with `live()` when a single verdict is noisy.

## Tiers

| Tier        | Model                                                                          | Cost                | Flag                                       | Use for                                            |
| ----------- | ------------------------------------------------------------------------------ | ------------------- | ------------------------------------------ | -------------------------------------------------- |
| Scripted    | `script()` / `scripts()` replies                                               | free, deterministic | none (default)                             | harness wiring, matchers, caching, MCP, flows      |
| Local       | Ollama (`TESTKIT_OLLAMA_MODEL`, `TESTKIT_OLLAMA_URL`, `TESTKIT_OLLAMA_TRIALS`) | free, slow, noisy   | `TESTKIT_OLLAMA=1`                         | trigger rates with small models                    |
| Haiku-class | cheap hosted model through the gateway's `forward`                             | paid                | `TESTKIT_LIVE=1` (+ `TESTKIT_FORWARD_KEY`) | trigger rates where small models confound          |
| Stronger    | larger hosted model                                                            | paid, most          | `TESTKIT_LIVE=1`                           | final checks on behavior a cheap model cannot show |

Tier env (resolved by `resolveTier`; a missing piece skips the test with a reason, it never falls through to a paid tier):

| Variable                                         | Meaning                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `TESTKIT_TIER`                                   | `local`, `haiku` or `deepseek`; unset skips                                 |
| `TESTKIT_<TIER>_BASE_URL`                        | upstream origin (`local`: Ollama `/v1`, default `localhost:11434`)          |
| `TESTKIT_<TIER>_KEY`                             | API key of a paid tier; pass it by env only, never write it to disk         |
| `TESTKIT_<TIER>_MODEL`                           | model id (defaults: `bonsai-2:9b`, `claude-haiku-5-5`, `DeepSeek-V4-Flash`) |
| `TESTKIT_TRIGGER_TRIALS`, `TESTKIT_TOKEN_BUDGET` | trigger matrix: max trials per prompt, input-token cap per tier run         |

`haiku` and `deepseek` use the Anthropic Messages wire (`forward.api: "anthropic"`); `local` uses OpenAI chat. `node scripts/run-tier.mjs <tier> -- <command>` fills these variables for one command from the user's `models.json` without printing the key.

## Cost rules

- Default to scripted; add a model only for a question a script cannot answer (does the model choose the tool).
- Paid tests never run without `TESTKIT_LIVE=1` and are skipped with a reason, never silently dropped.
- Forwarded runs use the run cache by default; set `TESTKIT_CASSETTE=record` to refresh it or `replay` to prohibit upstream calls (see Caching).
- Cap spend with `caps.maxRequests`; prefer `live()` below to a fixed large loop.
- Bound prompt and tool size with byte ceilings about 5% over the measured value.

## Caching

Two independent caches save different work:

| Cache                 | Hit does what?                                                    | What proves it?                                                                             |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Run cache (cassette)  | Replays the stored model reply; **no upstream request**           | `hits`, `upstreamCallsAvoided` in the run report                                            |
| Provider prompt cache | Sends the request upstream, reuses the stable prompt prefix there | Provider-reported `cachedTokens` on the trace (`cache_read_input_tokens` on Anthropic wire) |

A gateway with `forward` defaults to cassette mode `auto`: replay a hit, record a miss. Scripted gateways do not need a cassette and stay uncached unless explicitly recorded. `TESTKIT_CASSETTE=auto|record|replay|off` sets the default; `cassette.mode` overrides it. `replay` fails clearly on a missing file, missing request or stale fingerprint; `auto` replaces stale recordings and reports `stale` rather than silently trusting them.

```ts
const gw = await startGateway({
	forward: { baseUrl, model, api: "anthropic", key, promptCache: true },
	cassette: {
		file: "./__cassettes__/search.json",
		fingerprint: { adapter: { name: "inproc", version: "1" }, tier: "haiku", model },
	},
});
```

The header fingerprints adapter name/version, tier, model and an optional bundle hash. Supply the adapter/version for the harness under test; when testing a built bundle, add `bundle: fileHash(bundlePath)` to the fingerprint. The gateway fills the model and wire API when no tier is supplied. The key is the masked canonical request hash plus occurrence index: repeated identical requests retain separate replies. Occurrences count per gateway, so statistical trials that open a gateway per trial must pass `cassette: { sample: trial }`; otherwise trial 2 replays trial 1. Changing a prompt produces a miss; changing the fingerprint makes an existing recording stale. Older headerless cassette files need re-recording.

Without `cassette.file`, files live under `.octocode/tmp/testkit-cassettes/` with a filename derived from tier, model and upstream URL hash. Automatically named files older than 14 days are pruned. Explicit cassette files are not pruned. Files contain model replies and usage, not request bodies or authentication headers; treat model output as potentially sensitive. Do not commit recordings without reviewing them.

The package's Vitest config prints one summary and writes `.octocode/tmp/testkit-cache-report.json` at teardown. `TESTKIT_REPORT_DIR` overrides that location. A custom Vitest config must register `src/cache-report.ts` as `globalSetup` and set `TESTKIT_REPORT_DIR`; outside this config the fallback directory is the OS temp directory.

Read `hits`, `misses`, `stale` and `recorded` first, then `upstreamCallsAvoided` and `timeSavedMs` (sum of recorded upstream latency minus replay lookup time; not a whole-suite wall-clock speedup). `providerCache.cachedTokens` counts provider cache reads on newly recorded calls only; replayed usage is preserved in the trace but is not another provider cache read. The `cassettes` map breaks the totals down by file; `recordedRequests` preserves each new call's latency and provider usage (including `cachedTokens`). Tests with fake upstreams also contribute to this report; isolate a live test with `-t` when measuring a real provider.

For Anthropic, forwarding adds ephemeral `cache_control` markers by default (`forward.promptCache: false` turns them off) to the stable system prompt and last tool definition. The prefix must exceed the provider's cache minimum. `TESTKIT_TIER=haiku` enables the gated three-turn inproc cache test; it records once, checks real cache reads on a warm request, then replays with no `forward` configured. Paid tests require explicitly configured tier credentials.

## Statistical tests: `live()`

A model's behavior is a rate, not a boolean. `live(name, {maxTrials, threshold, minTrials?, confidence = 0.95}, trial)` runs trials until a Beta(1+successes, 1+failures) posterior decides:

| Posterior P(rate > threshold) | Decision                                                       |
| ----------------------------- | -------------------------------------------------------------- |
| ≥ confidence                  | `pass`, stop early                                             |
| ≤ 1 − confidence              | `fail`, stop early                                             |
| otherwise                     | keep sampling; `inconclusive` after `maxTrials` fails the test |

A trial that throws or returns `false` is a failure. With threshold 0.8 and confidence 0.95, 13 straight passes are enough to pass; 5 are not. The summary lands in the test's `meta.live`.

## Limits

- Matchers see only what the three probes show; an agent with no MCP or event probe is invisible to the matchers that need them.
- `cannot observe` on a missing probe cannot tell "probe not wired" from "agent did nothing"; wire the probe or assert on the gateway side.
- Token counts are estimates (chars / 4) unless forwarded from a real provider.
- Streaming and tool-call shapes: OpenAI chat-completions, Anthropic messages and OpenAI Responses SSE. Responses input maps messages, function calls and function outputs; other item types are not interpreted.
- Real-harness adapters spawn processes: need the built harness, local loopback sockets and a real clock (no fake timers).
- Claude Code and Codex adapters each skip with a reason when their CLI is missing.
