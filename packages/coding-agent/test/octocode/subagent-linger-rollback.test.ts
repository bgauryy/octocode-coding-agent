import fs from "node:fs";
import path from "node:path";
import { type CachePreferenceLayer, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import type * as RunExecution from "../../src/octocode/subagents/run-execution.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakePermission, fakeHost, meteredBilling } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };
const launch = vi.hoisted(() => ({ failNext: false }));

vi.mock("../../src/octocode/subagents/run-execution.ts", async (original) => {
	const real = await original<typeof RunExecution>();
	return {
		...real,
		startBackground: (...args: Parameters<typeof real.startBackground>) => {
			if (launch.failNext) {
				launch.failNext = false;
				throw new Error("launch failed");
			}
			return real.startBackground(...args);
		},
	};
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

beforeAll(() => {
	const root = tmp("octocode-agent-linger-asks-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

function setup() {
	const cwd = tmp();
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, { profiles: () => new Map(), team, permission: fakePermission("full") });
	const ctx = fakeCtx({ cwd });
	Object.assign(ctx, {
		model: { provider: "faux", id: "model" },
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => [],
			find: () => undefined,
			getCachePolicy: (_model: unknown, settings: readonly CachePreferenceLayer[] = []) =>
				mergeCachePreferences(settings),
		},
	});
	team.start(ctx);
	const reports = () => f.sent.map((entry) => String(entry.message.content)).filter((text) => text.includes("LINGER"));
	const start = async (task: string) =>
		(
			await f.tools
				.get("agent")
				.execute("call-1", { task, goal: "linger test", background: true }, undefined, undefined, ctx)
		).details.id as string;
	const finish = async () => {
		await control.stopAll();
		team.stop();
	};
	return { cwd, team, control, ctx, reports, start, finish };
}

describe("resuming a lingering subagent whose launch throws", () => {
	it("keeps the run parked so a second resume still finds it", async () => {
		process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS = "60";
		const t = setup();
		try {
			const id = await t.start("linger kept");
			await t.control.settle();
			expect(t.reports()).toHaveLength(1);
			launch.failNext = true;
			await expect(t.team.send(id, "linger again", { replyRequired: false })).rejects.toThrow("launch failed");
			// The failed launch left the run reachable and its unread report unmarked.
			expect(await t.team.send(id, "linger once more", { replyRequired: false })).toHaveProperty("resumed");
			await t.control.settle();
			expect(t.reports()).toHaveLength(2);
		} finally {
			delete process.env.OCTOCODE_SUBAGENT_LINGER_SECONDS;
			await t.finish();
		}
	}, 30_000);
});
