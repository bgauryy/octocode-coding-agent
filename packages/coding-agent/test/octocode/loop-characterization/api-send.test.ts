import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { OctocodeApi } from "../../../src/octocode/api/bridge.ts";
import type { ExternalAdmission, TurnCeiling } from "../../../src/octocode/api/bridge/contracts.ts";
import { ApiClient } from "../../../src/octocode/api/client.ts";
import { tmp } from "../helpers.ts";
import { blockingTool, count, createRig, wakeGateOf, type Rig, type RigOptions } from "./rig.ts";

let bridge: OctocodeApi | undefined;
let rig: Rig | undefined;
afterEach(async () => {
	await bridge?.stop();
	rig?.cleanup();
	vi.unstubAllEnvs();
});

async function start(tools?: RigOptions["tools"], eventWindowSeconds = 60) {
	const home = tmp();
	vi.stubEnv(ENV_AGENT_DIR, home);
	vi.stubEnv("OCTOCODE_HOME", home);
	writeFileSync(join(home, "settings.json"), JSON.stringify({ sessionApiTurnPermission: "workspace" }));
	const admissions: ExternalAdmission[] = [];
	let ceiling: TurnCeiling | undefined;
	const r = await createRig({
		tools,
		settings: { runtime: { eventWindowSeconds } },
		register: (api) => {
			bridge = new OctocodeApi(
				api,
				{ list: () => [], tell: () => ({}), deliverable: (text) => text },
				() => undefined,
				process.env,
				{
					admit: async (claim) => {
						admissions.push(claim);
						if (claim.text === "refuse me") throw new Error("refused admission");
					},
					capTurn: (next) => {
						ceiling = next;
					},
				},
			);
			bridge.observe();
		},
	});
	rig = r;
	await bridge!.start(r.ctx, { socket: false, http: 0 });
	const client = new ApiClient(bridge!.instance!);
	const task = (id = "task-41") =>
		wakeGateOf(r.api).emit(
			{ kind: "job.exit", job: id, exit: 0, durationMs: 1, startedAt: 0 },
			{ customType: "test-exit", content: `${id} finished`, display: false },
			{ triggerTurn: true },
		);
	const ask = (mode: "steer" | "followUp", text = "API-QUESTION") =>
		client.call("message.send", {
			text,
			from: "remote client",
			key: "request-key",
			wait: true,
			mode,
			timeoutMs: 5000,
		});
	const respond = (answer: string) => {
		const reply = r.reply(answer);
		return (context: Parameters<typeof reply>[0]) => {
			expect(ceiling).toBe("workspace");
			return reply(context);
		};
	};
	return { r, task, ask, respond, admissions, ceiling: () => ceiling };
}

it.each([1, 80])(
	"an admitted API request joins %i idle task completions in its first model request and owns the reply",
	async (size) => {
		const { r, task, ask, respond, admissions, ceiling } = await start();
		r.harness.setResponses([respond("final answer"), respond("extra request")]);
		const ids = Array.from({ length: size }, (_, i) => `job-${i}`);
		await Promise.all(ids.map(task));
		expect(r.requests).toHaveLength(0);
		const result = await ask("steer");
		await r.harness.session.waitForIdle();
		expect(r.requests).toHaveLength(1);
		expect(count(r.requests[0], "API-QUESTION")).toBe(1);
		for (const id of ids) expect(count(r.requests[0], `${id} finished`)).toBe(1);
		expect(result).toMatchObject({ id: "x1", queued: "turn", text: "final answer" });
		expect(ceiling()).toBeUndefined();
		expect(await ask("steer")).toEqual(result);
		expect(admissions).toMatchObject([{ text: "API-QUESTION", ceiling: "workspace" }]);
		expect(r.harness.getPendingResponseCount()).toBe(1);
	},
);

it.each([
	["steer", 1],
	["steer", 80],
	["followUp", 1],
	["followUp", 80],
] as const)(
	"preserves an admitted %s alongside %i active task completions, the ceiling, and the final reply",
	async (mode, size) => {
		const slow = blockingTool();
		const { r, task, ask, respond, ceiling } = await start([slow.tool]);
		r.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			respond("after the tool"),
			respond("after the follow-up"),
		]);
		const run = r.harness.session.prompt("start the tool");
		await slow.started;
		try {
			const ids = Array.from({ length: size }, (_, i) => `task-${i}`);
			await Promise.all(ids.map(task));
			const result = ask(mode);
			await vi.waitFor(() => expect(ceiling()).toBe("workspace"));
			slow.release();
			await run;
			await expect(result).resolves.toMatchObject({
				queued: mode,
				text: mode === "steer" ? "after the tool" : "after the follow-up",
			});
			await r.harness.session.waitForIdle();
			expect(r.requests).toHaveLength(mode === "steer" ? 1 : 2);
			for (const id of ids) expect(count(r.requests[0], `${id} finished`)).toBe(1);
			expect(count(r.requests[0], "API-QUESTION")).toBe(mode === "steer" ? 1 : 0);
			expect(count(r.requests.at(-1)!, "API-QUESTION")).toBe(1);
			expect(ceiling()).toBeUndefined();
		} finally {
			slow.release();
			await run;
		}
	},
);

it("refusing an external message leaves a held completion to wake the idle session", async () => {
	const { r, task, ask, ceiling } = await start(undefined, 0.3);
	r.harness.setResponses([r.reply("task handled")]);
	await task();
	await expect(ask("steer", "refuse me")).rejects.toThrow("refused admission");
	await vi.waitFor(() => expect(r.requests).toHaveLength(1));
	await r.harness.session.waitForIdle();
	expect(count(r.requests[0], "refuse me")).toBe(0);
	expect(count(r.requests[0], "task-41 finished")).toBe(1);
	expect(ceiling()).toBeUndefined();
});
