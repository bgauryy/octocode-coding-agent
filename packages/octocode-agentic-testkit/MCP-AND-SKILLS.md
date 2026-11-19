# Testing MCP servers and skills

How to test an MCP server or an Agent Skill the way agents use it: what the model reads before it acts, what the
server answers, how big and how fast the answers are, whether the right tool or skill is picked, and whether the
workflow it is meant for runs. The kit is not tied to any server, skill or platform. The worked example uses
octocode-mcp; swap in your own server's command or URL.

| Read                              | For                                                          |
| --------------------------------- | ------------------------------------------------------------ |
| this page                         | what to check for a server or a skill, and how, step by step |
| [README](README.md)               | setup, adapters and real models                              |
| [REFERENCE](REFERENCE.md)         | every option and matcher                                     |
| `test/example-mcp-server.test.ts` | the worked example, runnable as is                           |

## Put your server in front of an agent

`recordMcp` starts your real server (stdio) or connects to it (Streamable HTTP) and puts a recording HTTP endpoint in
front of it. Every adapter registers that endpoint like any MCP server, and every call lands on the trace with its
arguments, result size, latency and errors.

```ts
import { recordMcp, startGateway } from "@octocodeai/octocode-agentic-testkit";

const gw = await startGateway({ responder: script(steps) }); // or { forward } for a real model
const server = recordMcp({
	name: "octocode", // agents see its tools as mcp__octocode__<tool>
	trace: gw.trace,
	target: { command: "octocode", args: ["mcp"], cwd: workspace }, // or { url: "http://127.0.0.1:3000/mcp" }
});
const url = await server.listen(); // AdapterContext.mcpUrls: { octocode: url }
```

| You get                              | Use it for                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.defs`, `server.instructions` | the real `tools/list` and `initialize` instructions, for surface review                                                                                              |
| `server.client()`                    | calling the server directly, with no model, for contract tests                                                                                                       |
| `server.calls()`                     | every call: tool, args, agent, `isError`, result `chars` and `estTokens`, `argChars`, `durationMs`                                                                   |
| `server.summary()`                   | totals: calls, errors, result chars and tokens, the largest result, the slowest call, per tool                                                                       |
| trace events                         | `tool_exec` and `tool_error` (`reason`: `error-result`, `rpc-error`, `upstream`), so `toHaveCalledMcp`, `toReflect` and `toFollowTrajectory` work on the real server |
| `guards`                             | block a call before it reaches your server, such as a destructive tool in a test                                                                                     |
| `transformTools`                     | test-only: rewrite what agents see (one description, for an A/B run) while the real server still runs every call                                                     |

The server's own requests to its client are answered: `ping`, and `roots/list` with its working directory.

## What to check, server by server

Work from free to paid: most of a server's quality shows with no model at all.

| Question                                                                               | How                                                                                                                                                            | Model    |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| What does every request pay for my tools before the user types?                        | `analyzeSurface({ servers: [server], instructions })`: chars and estimated tokens per tool and in total                                                        | none     |
| Do descriptions reach the model, or does a host cut them off?                          | `analyzeSurface(input, CLAUDE_CODE_LIMITS)`: `description-truncated`, `instructions-truncated`                                                                 | none     |
| Will a host hide my tools behind a search?                                             | `contextWindowTokens` in the limits gives `tools-deferred`; on a real harness, check the first request's tools (Claude Code lists deferred tools by name only) | none     |
| Are parameters documented, schemas small and shallow, tools distinct?                  | `param-undocumented`, `open-object`, `schema-too-large`, `schema-too-deep`, `overlapping-tools` issues                                                         | none     |
| Does any text carry hidden instructions?                                               | `suspicious-instruction` issues (invisible Unicode, override phrases, secret reads)                                                                            | none     |
| Do my tools answer correctly, and fail clearly?                                        | `server.client().callTool(...)`; `isError`, the result text                                                                                                    | none     |
| How large and how slow are the answers?                                                | `server.summary()`: `maxChars`, `estTokens`, `maxDurationMs` per tool                                                                                          | none     |
| Does a real harness call it, pass the arguments through and show the model the answer? | a CLI adapter with `mcpUrls`, a scripted model, `toHaveCalledMcp`, the next request's messages                                                                 | scripted |
| Does the answer fit what the harness gives the model?                                  | `toKeepEnvelopesUnder({ toolOutputChars })`, `toolEnvelopes(trace)`                                                                                            | scripted |
| Does the intended workflow run: search, then fetch?                                    | `toFollowTrajectory([...], { mode: "ordered" })`                                                                                                               | scripted |
| After an error result, does the agent recover differently?                             | `toReflect({ after: "error" })`, `toNotRetryIdentically(tool)`                                                                                                 | either   |
| Does a model pick my tool for the prompts it should, and not for others?               | `probeRouting(cases, run)`: accuracy and a confusion matrix                                                                                                    | real     |
| How many calls, tokens and dollars does a task take?                                   | `toStayWithin({ requests, promptTokens, usd })`, `server.summary()`, `toHaveCacheReadRatio`                                                                    | real     |
| Did my new description route better?                                                   | `transformTools` for the variant, `liveCompare` for the verdict                                                                                                | real     |

## Step by step, with octocode-mcp

`test/example-mcp-server.test.ts` runs each step against the real server and skips with a reason when `octocode` (or
Claude Code) is not installed.

**1. The surface, no model.** Read what an agent will be sent and what it costs.

```ts
const server = recordMcp({ name: "octocode", trace: new Trace(), target: { command: "octocode", args: ["mcp"] } });
await server.ready();
const report = analyzeSurface(
	{ servers: [server], instructions: { octocode: server.instructions ?? "" } },
	{ ...CLAUDE_CODE_LIMITS, contextWindowTokens: 200_000 },
);
expect(report.issues.filter((i) => i.kind === "suspicious-instruction")).toEqual([]);
```

One run of the example prints the totals and the issue counts by kind:

```text
[mcp-example:surface] {"tools":14,"chars":72917,"estTokens":18230,"issues":{"description-too-long":3,"schema-too-large":6,"schema-too-deep":8,"param-undocumented":172,"surface-too-large":1}}
```

That is about 18k tokens on every request of every session, before the user's first word: worth a budget test
(`expect(report.estTokens).toBeLessThan(...)`, set about 5% above the measured size).

**2. The contract, no model.** Call the tools directly and measure.

```ts
const r = await server.client().callTool("localSearch", {
	queries: [
		{ path: workspace, matchString: ["parseConfig"], mainGoal: "who calls parseConfig", reasoning: "find callers" },
	],
});
expect(r.isError).toBe(false);
expect(r.text).toContain("src/app.ts");
expect(server.summary().byTool.localSearch.maxChars).toBeLessThan(20_000);
```

**3. In a real harness, scripted.** Claude Code runs unchanged. The script plays the model, so the test is free and
exact about what the server receives and returns.

```ts
const gw = await startGateway({
	responder: script([
		{ toolCalls: [{ name: "mcp__octocode__localSearch", args: search }] },
		{ toolCalls: [{ name: "mcp__octocode__localFetch", args: { queries: [{ path: `${workspace}/src/app.ts` }] } }] },
		{ text: "src/app.ts calls parseConfig on line 2." },
	]),
});
const server = recordMcp({
	name: "octocode",
	trace: gw.trace,
	target: { command: "octocode", args: ["mcp"], cwd: workspace },
});
const session = await claudeCodeAdapter().start({
	gatewayUrl: gw.url,
	workdir: workspace,
	mcpUrls: { octocode: await server.listen() },
});
await session.run("who calls parseConfig?");

expect(gw.trace).toHaveCalledMcp("octocode", "localSearch", { before: "answer" });
expect(gw.trace).toFollowTrajectory(["mcp__octocode__localSearch", "mcp__octocode__localFetch"], { mode: "ordered" });
expect(gw.trace).toKeepEnvelopesUnder({ toolOutputChars: 20_000 });
expect(server.summary()).toMatchObject({ calls: 2, errors: 0 });
```

The example also reports whether Claude Code deferred the server's tools behind its tool search (the first request
then carries `ToolSearch` and none of `mcp__octocode__*`). On a deferring host, a real model sees only the tool names
until it searches, so routing tests (step 4) must count that extra step.

**4. With a real model.** Turn on a tier (see [Add a real model](README.md#add-a-real-model)) and measure rates.

```ts
const report = await probeRouting(
	[
		{ prompt: "who calls parseConfig?", expect: "mcp__octocode__lspSearch" },
		{ prompt: "list the files under src", expect: "mcp__octocode__structureSearch" },
		{ prompt: "what is 2 + 2?", expect: null }, // no tool at all
	],
	async (prompt, guards) => {
		const gw = await startGateway({ forward: forwardOf(tier), guards });
		const session = await claudeCodeAdapter().start({
			gatewayUrl: gw.url,
			mcpUrls: { octocode: await server.listen() },
		});
		await session.run(prompt);
		await session.close();
		return gw.trace;
	},
);
expect(report.accuracy).toBeGreaterThanOrEqual(0.8);
```

`probeRouting` blocks every call, so a case costs about one model request. For efficiency, run whole tasks with
`live()` and check `toStayWithin({ requests: 6, promptTokens: 60_000 })` and `server.summary().calls` per trial. To
compare two descriptions, run `liveCompare` with `transformTools` setting the variant.

## Skills

A skill is a `SKILL.md` a harness lists by its description and loads when a task matches. Install the skill under
test into the harness's isolated home:

| Harness        | Option                                             | Lands in                                     |
| -------------- | -------------------------------------------------- | -------------------------------------------- |
| Claude Code    | `claudeCodeAdapter({ skills: { name: text } })`    | `<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md` |
| Codex          | `codexAdapter({ skills: { name: text } })`         | `<CODEX_HOME>/skills/<name>/SKILL.md`        |
| Octocode Agent | `octocodeAgentAdapter({ skills: { name: text } })` | `<agent home>/skills/<name>/SKILL.md`        |
| your adapter   | write the files where your harness reads skills    |                                              |

| Question                                                          | How                                                                                                                                                          | Model    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Is the description within limits and free of hidden instructions? | `analyzeSurface({ skills: [{ name, description }] })`: `skill-description-too-long` past 1,024 characters (the Agent Skills limit), `suspicious-instruction` | none     |
| Does the harness list the skill to the model?                     | the first request contains the description (`JSON.stringify(trace.requests[0].raw)`)                                                                         | scripted |
| Does it load, and does its workflow run?                          | `toHaveLoadedSkill(name)`, `toFollowTrajectory(["Skill", ...], { mode: "ordered" })`                                                                         | scripted |
| What does loading it cost?                                        | the skill body as a tool result: `toolEnvelopes(trace)`, `toKeepEnvelopesUnder`                                                                              | scripted |
| Does it load for the prompts it should, and not for near misses?  | `live()` with `toHaveLoadedSkill`, or `probeRouting` with `expect: "skill:<name>"`                                                                           | real     |
| Does the task go better with it?                                  | `liveCompare` with `base` without the skill and `treatment` with it (an ablation)                                                                            | real     |

A skill that is meant to use your server, scripted, on Claude Code:

```ts
const gw = await startGateway({
	responder: script([
		{ toolCalls: [{ name: "Skill", args: { skill: "find-callers" } }] },
		{ toolCalls: [{ name: "mcp__octocode__localSearch", args: search }] },
		{ text: "src/app.ts calls it." },
	]),
});
const session = await claudeCodeAdapter({ skills: { "find-callers": SKILL_MD } }).start({
	gatewayUrl: gw.url,
	mcpUrls: { octocode: await server.listen() },
});
await session.run("who calls parseConfig?");
expect(JSON.stringify(gw.trace.requests[0].raw)).toContain("Use when the user asks who calls a function");
expect(gw.trace).toHaveLoadedSkill("find-callers");
expect(gw.trace).toFollowTrajectory(["Skill", "mcp__octocode__localSearch"], { mode: "ordered" });
```

Trigger rates need a model: a skill's description is a classifier the model runs on every prompt. Test a matrix of
prompts that should fire, near misses that should not, and unrelated prompts, with a real tier and `live()`; a
single sample proves nothing. Start on a free local model (`TESTKIT_TIER=local`) and confirm on a hosted tier only
when the local one misses.

## In CI

| Run         | What                                                                                                          | Cost         |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------ |
| every PR    | surface review with a token budget, contract calls, scripted harness runs, skill listing and loading          | $0           |
| nightly     | routing and trigger matrices, efficiency budgets with `live()`, replayed from cassettes where nothing changed | paid, capped |
| on a change | `liveCompare` of the old and new description or skill                                                         | paid         |

Cap paid runs with `caps.maxUsd` or `budgetUsd`, and record them once into a committed `TESTKIT_CASSETTE_DIR` so a
rerun with no change replays for free.
