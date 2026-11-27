import { describe, expect, it } from "vitest";
import { registerAgentHooks } from "../../src/octocode/hooks/register/agents.ts";
import { AGENT_CHAIN_CHANNEL } from "../../src/octocode/shared/agent-chain.ts";
import { AGENT_LIFECYCLE_CHANNEL, type AgentLifecycleNotice } from "../../src/octocode/shared/agent-lifecycle.ts";

/** The hooks of a session whose three presence events each have one group, driven by a real emitter and a recording dispatch. */
function harness() {
	const channels = new Map<string, Array<(data: unknown) => void>>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const api = {
		bus: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		},
		channels: {
			on: (channel: string, handler: (data: unknown) => void) => {
				channels.set(channel, [...(channels.get(channel) ?? []), handler]);
				return () => undefined;
			},
			emit: (channel: string, data: unknown) => channels.get(channel)?.forEach((handler) => handler(data)),
		},
	};
	const group = { hooks: [{ timeoutMs: 100 }] };
	const session = { config: { AgentQueued: [group], AgentOn: [group], AgentOff: [group] } };
	const seen: Array<{ event: string; matcher: string; input: Record<string, unknown> }> = [];
	registerAgentHooks(api as never, session as never, {
		dispatch: (async (_ctx: unknown, event: string, names: string[], build: () => Record<string, unknown>) => {
			seen.push({ event, matcher: names[0], input: build() });
		}) as never,
		reportFailure: () => undefined,
	});
	return {
		api,
		seen,
		start: () => handlers.get("session_start")![0]({}, {}),
		flush: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
	};
}

const lifecycle = (
	kind: "on" | "off",
	agent: string,
	extra: Partial<AgentLifecycleNotice> = {},
): AgentLifecycleNotice => ({
	seq: kind === "on" ? 3 : 4,
	kind,
	agent,
	role: "general",
	parent: null,
	time: "2026-11-15T10:00:00.000Z",
	data: {},
	...(kind === "off" ? { reason: "completed" } : {}),
	...extra,
});

describe("chain fields on the presence hooks", () => {
	it("gives AgentQueued its prerequisites and item, matched by role", async () => {
		const h = harness();
		await h.start();
		h.api.channels.emit(AGENT_CHAIN_CHANNEL, {
			kind: "queued",
			agent: "kelp",
			role: "reviewer",
			after: ["B12", "agent:sly"],
			item: "B14",
		});
		await h.flush();
		expect(h.seen).toEqual([
			{
				event: "AgentQueued",
				matcher: "reviewer",
				input: { seq: null, agent_id: "kelp", agent_type: "reviewer", after: ["B12", "agent:sly"], item: "B14" },
			},
		]);
	});

	it("gives AgentOn started_after and the prerequisite's AgentOff releases, or holds on failure", async () => {
		const h = harness();
		await h.start();
		h.api.channels.emit(AGENT_CHAIN_CHANNEL, {
			kind: "released",
			agent: "kelp",
			role: "general",
			after: ["agent:sly"],
			seq: 4,
		});
		h.api.channels.emit(AGENT_CHAIN_CHANNEL, {
			kind: "held",
			agent: "moss",
			role: "general",
			after: ["agent:sly"],
			failed: ["agent:sly"],
		});
		h.api.channels.emit(AGENT_LIFECYCLE_CHANNEL, lifecycle("off", "sly"));
		h.api.channels.emit(AGENT_LIFECYCLE_CHANNEL, lifecycle("on", "kelp"));
		await h.flush();
		const off = h.seen.find((each) => each.event === "AgentOff")!;
		expect(off.input).toMatchObject({ releases: ["kelp"], holds: ["moss"] });
		const on = h.seen.find((each) => each.event === "AgentOn")!;
		expect(on.input).toMatchObject({ started_after: { prerequisites: ["agent:sly"], seq: 4 } });
	});
});
