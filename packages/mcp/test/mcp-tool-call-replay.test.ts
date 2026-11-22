import { writeFile } from "node:fs/promises";
import { afterEach, it, expect, vi } from "vitest";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { prepareToolCall } from "../../agent/src/agent-loop/tool-call.ts";
import { restoredSchemas, RESTORE_SCHEMAS_CHARS } from "../../coding-agent/src/octocode/compaction/deferred-schemas.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import { replayCases } from "../../octocode-agentic-testkit/examples/tool-call-replay.ts";
import { firstToolCallDifference, type ToolCallStages } from "../../octocode-agentic-testkit/src/tool-call-replay.ts";
import { LATEST_PROTOCOL_VERSION } from "../src/client/index.ts";
import { createInMemoryTransportPair } from "../src/client/testing/index.ts";
import { deferredInputSchema } from "../src/deferred-schema.ts";
import { mcpHost } from "./mcp-host-fixture.ts";
import { scriptedCall, type Route } from "./replay/provider.ts";

function replayHost(deferred: boolean) {
	const pair = createInMemoryTransportPair();
	const calls: unknown[] = [];
	const replies: Promise<void>[] = [];
	pair.server.onMessage((message) => {
		if (!("method" in message && "id" in message)) return;
		let result: unknown;
		switch (message.method) {
			case "initialize":
				result = {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "replay", version: "1" },
				};
				break;
			case "tools/list":
				result = {
					tools: replayCases.map(({ name, inputSchema }) => ({
						name,
						inputSchema,
						description: `Inspect synthetic ${name} samples.`,
					})),
				};
				break;
			case "tools/call":
				if (!isRecord(message.params)) throw new Error("Missing call parameters");
				calls.push(message.params.arguments);
				result = { content: [{ type: "text", text: "ok" }] };
				break;
			default:
				throw new Error(`Unexpected MCP request ${message.method}`);
		}
		replies.push(pair.server.send({ jsonrpc: "2.0", id: message.id, result }));
	});
	const host = mcpHost({
		presets: [],
		presentation: "declared",
		exposure: deferred ? "usage" : "direct",
		servers: [{ name: "replay", config: { command: "in-memory" }, source: "test" }],
		createTransport: () => pair.client,
	});
	// This session selects the management tool so it can load deferred schemas.
	host.api.tools.getActive = () =>
		[...host.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name);
	return {
		host,
		calls,
		async start() {
			await pair.server.start();
			await host.start();
			await host.prompt();
		},
		async close() {
			await host.close();
			await pair.server.close();
			await Promise.all(replies);
		},
	};
}

const states = ["full", "thin", "loaded", "restored"] as const;

type State = (typeof states)[number];
type Scenario = (typeof replayCases)[number];

async function declaredTool(host: ReturnType<typeof mcpHost>, state: State, scenario: Scenario) {
	const name = `mcp__replay__${scenario.name}`;
	const tool = host.tools.get(name);
	expect(tool, name).toBeDefined();
	expect(deferredInputSchema(tool.parameters)).toEqual(state === "full" ? undefined : scenario.inputSchema);
	let guidance;
	if (state === "loaded") {
		const result = await host.call("mcp", { intent: "tools", server: "replay", tool: scenario.name });
		const loaded = result.content.map((part: { text: string }) => part.text).join("\n");
		expect(loaded).toContain(JSON.stringify(scenario.inputSchema, null, 2));
		guidance = { loaded, name: scenario.name };
	} else if (state === "restored") {
		const restored = restoredSchemas([tool], [name], [name], RESTORE_SCHEMAS_CHARS);
		expect(restored?.content).toContain(JSON.stringify(scenario.inputSchema));
		guidance = { restored: restored!.content };
	}
	return { tool, guidance };
}

async function runControl(
	session: ReturnType<typeof replayHost>,
	declaration: Awaited<ReturnType<typeof declaredTool>>,
	state: State,
	scenario: Scenario,
	route: Route,
	control: "valid" | "malformed",
) {
	const { host, calls } = session;
	const { tool, guidance } = declaration;
	const started = performance.now();
	const { assistant, call, rawDeltas, estimatedTokens } = await scriptedCall(
		route,
		tool,
		scenario.prompt,
		scenario[control],
		guidance,
	);
	let beforeValidation: unknown;
	const observed = {
		...tool,
		prepareArguments(args: unknown) {
			const prepared: unknown = tool.prepareArguments ? tool.prepareArguments(args) : args;
			beforeValidation = structuredClone(prepared);
			return prepared;
		},
	};
	const beforeCount = calls.length;
	const prepared = await prepareToolCall({ messages: [], tools: [observed] }, assistant, call, {}, undefined);
	let validation: ToolCallStages["validation"];
	if (prepared.kind === "prepared") {
		validation = { accepted: true, arguments: structuredClone(prepared.args) };
		await host.call(tool.name, prepared.args as Record<string, unknown>);
	} else {
		validation = {
			accepted: false,
			error: prepared.result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
		};
	}
	const stages: ToolCallStages = {
		rawDeltas,
		assistant: call.arguments,
		beforeValidation,
		validation,
		serverCalls: calls.slice(beforeCount),
	};
	const difference = firstToolCallDifference(scenario.valid, stages);
	expect(rawDeltas.length).toBeGreaterThan(1);
	expect(stages.assistant).toEqual(scenario[control]);
	expect(stages.beforeValidation).toEqual(scenario[control]);
	expect(validation.accepted).toBe(control === "valid");
	expect(stages.serverCalls).toEqual(control === "valid" ? [scenario.valid] : []);
	expect(difference).toBe(control === "valid" ? "none" : "provider-deltas");
	return {
		state,
		scenario: scenario.name,
		intendedArguments: scenario.valid,
		route,
		control,
		stages,
		difference,
		estimatedTokens,
		localLatencyMs: performance.now() - started,
	};
}

afterEach(() => vi.unstubAllEnvs());

it("characterizes synthetic calls across declaration states and wire adapters without network", async () => {
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
	const rows: Awaited<ReturnType<typeof runControl>>[] = [];
	for (const state of states) {
		const session = replayHost(state !== "full");
		try {
			await session.start();
			for (const scenario of replayCases) {
				const declaration = await declaredTool(session.host, state, scenario);
				for (const route of ["bedrock", "completions"] as const) {
					for (const control of ["valid", "malformed"] as const) {
						rows.push(await runControl(session, declaration, state, scenario, route, control));
					}
				}
			}
		} finally {
			await session.close();
		}
	}
	expect(rows).toHaveLength(48);
	const report = process.env.MCP_REPLAY_REPORT;
	if (report) {
		const byState = states.map((state) => {
			const trials = rows.filter((row) => row.state === state);
			return { state, calls: trials.length, rejected: trials.filter((row) => !row.stages.validation.accepted).length };
		});
		await writeFile(
			report,
			JSON.stringify({ mode: "scripted", cacheReadTokens: null, cacheWriteTokens: null, byState, rows }, null, 2),
		);
	}
}, 30_000);
