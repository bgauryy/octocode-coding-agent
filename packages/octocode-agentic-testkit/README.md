# agentic-testkit

Vitest-native behavior tests for agent harnesses: scripted model replies, mock MCP servers, a recorded trace of one run and matchers over that trace. It knows no harness: a harness plugs in through a small adapter. Status: proof of concept, internal for now.

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

| Adapter                                      | Status   | How it connects                                                                                                                                                                                            |
| -------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference` (`src/adapters/reference`)       | works    | In-process tool loop (skills, memory, spawn, compaction); MCP clients passed as options, not `mcpUrls`; emits every event kind                                                                             |
| `octocodecode` (`src/adapters/octocodecode`) | works    | Spawns the built CLI in a temp HOME with `models.json` (gateway) and `mcp.json` (mock URLs); bundle path from `bundle` option or `TESTKIT_OCTOCODECODE_BUNDLE`; `parseSkillListing` reads its skill prompt |
| Claude Code                                  | unproven | Set `ANTHROPIC_BASE_URL=<gatewayUrl>` and a dummy key in `env`; MCP via `--mcp-config` file with the mock URL                                                                                              |
| Codex CLI                                    | unproven | `config.toml` with a `[model_providers.testkit]` entry (`base_url = <gatewayUrl>/v1`, `wire_api = "chat"`) and `[mcp_servers.*]` url entries                                                               |

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
- Record once, replay free: `cassette: { file, mode: "record" | "replay" }` on the gateway; a replay miss fails the request.
- Cap spend with `caps.maxRequests`; prefer `live()` below to a fixed large loop.
- Bound prompt and tool size with byte ceilings about 5% over the measured value.

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
- Streaming and tool-call shapes: OpenAI chat-completions and Anthropic messages only.
- Real-harness adapters spawn processes: need the built harness, local loopback sockets and a real clock (no fake timers).
- Claude Code and Codex adapters are unproven.
