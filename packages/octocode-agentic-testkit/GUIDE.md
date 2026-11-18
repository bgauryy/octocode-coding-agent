# Developer guide

This guide covers how to write, run and maintain agent behavior tests with the testkit. The [README](README.md) says
what to test and how to connect an agent; the [REFERENCE](REFERENCE.md) lists every option, result type and matcher.

## Run the suites

Run these in `packages/octocode-agentic-testkit`. From the repository root, `yarn test:agentic` runs `yarn test` here plus the `scripts/agent-eval/` tests; the root `yarn test` leaves both out.

| Goal                                     | Command                                            | Cost                                     |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| every free test                          | `yarn test`                                        | $0, seconds                              |
| harness guards (prompt size, cache, MCP) | `yarn test:guards`                                 | $0                                       |
| types                                    | `yarn typecheck`                                   | $0                                       |
| prompt shape of every agent (bundle)     | `TESTKIT_MEASURE_LABEL=<name> yarn measure`        | $0, ~30 s                                |
| skill triggers on local Ollama           | `yarn test:triggers`                               | $0, ~30 min                              |
| a paid tier                              | `TESTKIT_LIVE=1 yarn tier haiku -- yarn test:live` | paid; cap it with `TESTKIT_TOKEN_BUDGET` |

`yarn tier <name>` copies the tier's credentials from your `models.json` into the child process. It only reads the
file and never prints a key. Paid tests are named `*.live.test.ts`: `yarn test` never collects them, `yarn test:live` runs only them (it sets `OCTOCODE_LIVE_TESTS=1`), and without `TESTKIT_LIVE=1` and a tier they still skip with a reason.

## Write a test

1. Start a gateway with scripted replies. Add a mock MCP server if the agent uses tools.
2. Run your agent through an adapter, or through `referenceAdapter` for the in-process loop.
3. Assert on the trace.

For a multi-turn flow, repeated runs or a spend cap, write an `agentSuite` instead (see the
[README](REFERENCE.md#suites)). It starts and closes the gateway, the mocks and the session for every run, and each test
is the next turn.

Rules:

- Assert on behavior (which tool was called, with what, in what order; skills; retries), not on the wording of the
  answer. Use `judge` only when the wording is the point.
- Every new matcher needs a must-fail case in `test/matchers.negative.test.ts`.
- When a check throws `cannot observe`, wire the probe it needs; never loosen the test.
- Block a dangerous call with a guard rather than asserting after it ran: a guard stops it before any harness
  executes it.
- Close what you start: the session, then the mocks, then the gateway.

## Recipes

Each recipe assumes `gw` is a gateway, `docs` a mock MCP server on `gw.trace`, and `session` a started adapter.
`test/guide-recipes.test.ts` runs the scripted ones.

**Recovery after an HTTP error.** The first request gets a 429, then the script answers normally.

```ts
const gw = await startGateway({
	responder: script([{ error: { status: 429, retryAfterSeconds: 1 } }, { text: "done" }]),
});
```

**Recovery after a tool failure.**

```ts
docs.tool("search").failOnce("error");
await session.run("find the cache docs");
expect(gw.trace).toReflect({ after: "error" });
expect(gw.trace).toNotRetryIdentically("search");
```

**Call order.** `superset` allows extra calls; `strict` requires exactly these calls.

```ts
expect(gw.trace).toFollowTrajectory(["search", { tool: "fetch", args: { id: "a" } }], { mode: "superset" });
```

**A budget.**

```ts
expect(gw.trace).toStayWithin({ requests: 4, promptTokens: 20_000 });
```

**Final state.** The workspace exists until `close()`.

```ts
const session = await octocodecodeAdapter().start({ gatewayUrl: gw.url, files: { "a.txt": "teh" } });
const run = await session.run("fix the typo in a.txt");
expect(run.exitCode).toBe(0);
expect(readFileSync(join(run.workspace, "a.txt"), "utf8")).toBe("the");
await session.close();
```

**Several agents.** Scripts are keyed by agent: the `x-testkit-agent` header, or the role the gateway inferred for a
real CLI (the spawn call's `subagent_type`, `type`, `role` or similar argument). `spawn_agent` is the reference loop's
spawn tool; use your harness's own spawn tool name, such as Claude Code's `Agent` with `subagent_type`.

```ts
const gw = await startGateway({
	responder: scripts({
		main: [{ toolCalls: [{ name: "spawn_agent", args: { role: "researcher", task: "look" } }] }, { text: "done" }],
		researcher: [{ text: "found it" }],
	}),
});
// run, then:
expect(gw.trace).toHaveHandedOff("main", "researcher");
expect(gw.trace).toHaveNoOrphanAgents();
```

**A real CLI's subagent.** No header is needed: the child is recognized by its task.

```ts
const gw = await startGateway({
	responder: scripts({
		main: [
			{ toolCalls: [{ name: "Agent", args: { subagent_type: "general-purpose", prompt: "Reply with REPORT-9." } }] },
			{ text: "main finished" },
		],
		"general-purpose": [{ text: "REPORT-9" }],
	}),
});
const session = await claudeCodeAdapter().start({ gatewayUrl: gw.url });
await session.run("delegate a check");
expect(gw.trace).toHaveHandedOff("main", "general-purpose");
expect(gw.trace).toHaveNoOrphanAgents();
```

**A faulty model.** Each step covers one fault a harness must survive.

```ts
script([
	{ error: { status: 429, retryAfterSeconds: 1 } },
	{ toolCalls: [{ name: "search", rawArgs: '{"query": "ca' }] }, // malformed arguments
	{ text: "cut", stop: "max_tokens" },
	{ disconnect: "mid-stream" },
	{ text: "done" },
]);
```

**The outcome.** Grade the files the run left, not only the calls it made.

```ts
const run = await session.run("fix the typo in a.txt");
expect(run).toHaveWorkspace({ "a.txt": "the" });
expect(await runVerifier(run.workspace, "node", ["--test"])).toPassVerifier();
```

**A forbidden call.** The gateway drops the call before the harness sees it, so the tool never runs.

```ts
const gw = await startGateway({ responder: script(steps), guards: [never("delete_*"), maxToolCalls(20)] });
// … run the agent …
expect(repo.tool("delete_repo")).not.toHaveBeenCalled();
expect(gw.trace).toHaveBlocked("delete_repo");
```

**A spend cap.** Prices are USD per million tokens. Scripted runs are priced on their estimated usage, so the cap
itself is testable for free.

```ts
const gw = await startGateway({ forward, caps: { pricing: { input: 1, output: 5 }, maxUsd: 0.05 } });
// … run the agent …
expect(gw.trace).toStayWithin({ usd: 0.06 });
```

**The tool surface the model sees.** This reads the tools the harness actually sent, built-in tools included, and
needs no model.

```ts
const report = analyzeSurface({ tools: surfaceOfRequest(gw.trace.requests[0]) }, CLAUDE_CODE_LIMITS);
expect(report).toPassSurfaceReview({ allow: ["param-undocumented"] });
```

**A real model, sandboxed.** Forwarding sandboxes the CLI by default, so a model's Bash call cannot write outside the
workspace or read `~/.ssh`.

```ts
const gw = await startGateway({ forward: forwardOf(tier) });
const session = await claudeCodeAdapter().start({ gatewayUrl: gw.url }); // sandboxed: the gateway forwards
```

**Did the change help?** Compare a baseline with the change on fresh samples.

```ts
liveCompare(
	"the new description routes better",
	{ variants: { base: "old", treatment: "new" }, trials: 20, expect: "better" },
	async ({ variant, trial }) => {
		/* … run with that description … */ return routedRight;
	},
);
```

**A behavior rate, with consistency.** This needs a model tier: a script would always pass.

```ts
live("picks search for a docs question", { maxTrials: 20, threshold: 0.8, k: 3 }, async ({ trial }) => {
	const gw = await startGateway({ forward: forwardOf(tier), cassette: { sample: trial } });
	// … run the agent …
	return gw.trace.of("model_tool_call").some((e) => e.name === "search");
});
```

## Look at results

Call `saveResult(ctx, { trace: gw.trace, live, judgement, run })` at the end of a test. With
`TESTKIT_RESULTS_DIR` set, it writes one JSON file per test; without it, nothing is written. Then:

```bash
TESTKIT_RESULTS_DIR=../../.octocode/tmp/testkit-results yarn vitest run test/my.test.ts
yarn results ../../.octocode/tmp/testkit-results            # one line per test, failures first
yarn results ../../.octocode/tmp/testkit-results "cache"    # the first match, as Markdown
```

## Pick a tier

| Question                                                                   | Tier                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| Does the harness send the right tools, prompt, MCP calls and cache prefix? | scripted: free and deterministic                        |
| Does a model pick the right skill or tool? (first pass)                    | `local` (Ollama)                                        |
| A small model misses: is the description at fault, or the model?           | `haiku`. Blame the description only if Haiku misses too |
| Which tool does each prompt route to, for the least spend?                 | `probeRouting` on a model tier: one request per prompt  |

For a grader whose verdict you must trust, use `judgePanel` with two or three models and check `agreement`: a
verdict that flips between graders says the rubric needs sharper criteria, not more runs.

Model behavior is a rate, so use `live()` or `runTrials()`. Throw `NoAnswer` from a trial on a timeout, 429 or 5xx,
so infrastructure errors never count as failures.

## Caching

There are two caches, and they save different work:

| Cache                 | A hit                                                        | Proof                                         |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------- |
| Run cache (cassette)  | replays the stored reply, with no upstream request           | `hits`, `upstreamCallsAvoided` in the report  |
| Provider prompt cache | sends the request, and the provider reuses the stable prefix | provider-reported `cachedTokens` on the trace |

Workflow:

1. Record once on a paid tier. `TESTKIT_CASSETTE=auto`, the default with `forward`, replays hits and records misses.
2. Rerun freely. Hits replay, and the report prints `hits / misses / stale`.
3. When you change the agent, a prompt or the model, those requests miss or their fingerprint goes stale, and `auto`
   re-records only them.
4. In CI, set `TESTKIT_CASSETTE=replay` and `TESTKIT_CASSETTE_DIR` (or `cassette.dir`) to a committed directory
   recorded in step 1. It fails on any miss instead of spending.
5. For fresh samples, such as new statistics, set `TESTKIT_CASSETTE=record` or `off`.

Details:

- **When it is on.** Scripted gateways use no cassette unless you pass one; `cassette.mode` overrides the variable.
- **Fingerprint.** It covers the adapter name and version, the tier, the model, and optionally a bundle hash. When
  testing a built bundle, add `bundle: fileHash(bundlePath)`.
- **Request key.** Each request is keyed by its masked canonical hash (model, messages, tools) and its sampling
  settings (`temperature`, `tool_choice`, `max_tokens`, thinking and the like; volatile ids such as `metadata` and
  `prompt_cache_key` stay out), plus an occurrence index, counted per gateway.
  Trials that open a gateway each must therefore pass `cassette: { sample: trial }`, or trial 2 replays trial 1.
- **Storage.** Without `cassette.file`, files go under `TESTKIT_CASSETTE_DIR` (or `cassette.dir`), else
  `.octocode/tmp/testkit-cassettes/`. Only auto-named files in that default tmp directory are pruned after 14 days.
  Concurrent workers merge their recordings under a file lock, so no entry is lost. Files hold model replies and usage, but no request bodies or auth headers; review them before
  committing.
- **Report.** It is written to `.octocode/tmp/testkit-cache-report.json`, or under `TESTKIT_REPORT_DIR`. `testkitConfig()`
  registers the report as `globalSetup`. `timeSavedMs` is recorded upstream latency
  minus lookup time, not a wall-clock speedup. `providerCache.cachedTokens` counts reads on newly recorded calls only.
- **Anthropic prompt cache.** Forwarding marks the last system block and the last tool with ephemeral `cache_control`
  when the request carries no markers of its own; `forward.promptCache: false` turns that off. The prefix must exceed the provider's cache minimum.

## Add an adapter

For a CLI, follow the [adapter checklist](REFERENCE.md#plug-in-your-agent) and start from `src/adapters/codex` (a
config file plus `runProcess`) or `src/adapters/claude-code` (flags plus environment). For an agent that runs in the
test process (LangChain, the Vercel AI SDK, your own loop), start from the matching file in
[examples/adapters](examples/README.md). Prove it with three scripted tests: a
request reaches the gateway, `toHaveCalledMcp` passes, and the CLI being missing gives a skip with a reason
(`unavailable()`).

## Troubleshooting

| Symptom                          | Cause                                                                | Fix                                                                            |
| -------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `cannot observe: no event probe` | the adapter reports no harness events                                | record them and call `trace.observe("events")`, or check on the gateway side   |
| `cannot observe` (other)         | the probe for that data is not wired                                 | connect the mock MCP, or check the gateway trace                               |
| `script exhausted after N steps` | `onExhausted: "fail"` and the agent made more requests than scripted | add steps, or find out why the agent loops                                     |
| `cassette stale`                 | the agent, bundle, tier or model changed                             | rerun with `auto` to re-record                                                 |
| `cassette miss` in replay        | a new or reordered request, or changed sampling settings             | rerun with `auto` and review the diff                                          |
| `cassette … does not exist`      | replay found no recording at the named path                          | record it with `TESTKIT_CASSETTE=auto` into a committed `TESTKIT_CASSETTE_DIR` |
| `lock … still held`              | another worker held the cassette lock for 30 s                       | find the stuck worker; a lock older than 10 s is broken as stale               |
| a child shows up as `main:aux`   | the lineage found no task of a pending call in its first message     | give the spawn call the task text, or send `x-testkit-agent` from the harness  |
| `sandbox … unavailable`          | the platform has no supported sandbox (macOS only)                   | pass `sandbox: false` to run unsandboxed on purpose                            |
| identical results across trials  | the trials replay one recording                                      | pass `cassette: { sample: trial }`                                             |
| 0 cached provider tokens         | the prefix is under the provider minimum, or `promptCache: false`    | lengthen the stable prefix, or keep the default                                |
| Codex never calls the MCP tool   | its approval policy                                                  | the adapter sets `default_tools_approval_mode = "approve"`                     |
| `turn stopped early: guard: …`   | a guard or cap stopped a suite turn                                  | fix the agent, or pass `{ allowStop: true }` when the stop is the point        |
| `k/n runs passed, m needed`      | too few suite runs passed the test                                   | read each run's first error; lower `pass` only for a rate you have measured    |
| a spy shows 0 calls in turn 2    | Vitest clears spy history before each test (`clearMocks`)            | assert earlier turns on the context's `trace`                                  |
