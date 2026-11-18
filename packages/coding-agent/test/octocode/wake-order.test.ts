import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.OCTOCODE_HOME = tmp();
	delete process.env.OCTOCODE_SUBAGENT;
	vi.spyOn(os, "homedir").mockReturnValue(tmp());
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = saved;
});

/** The source files whose handlers for `event` the composed extension registers, in the order they run. */
async function registrants(event: string): Promise<string[]> {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const fake = fakeHost();
	Object.assign(fake.api.session, { getName: () => undefined });
	const files: string[] = [];
	const on = fake.api.bus.on.bind(fake.api) as (name: string, handler: never) => void;
	(fake.api.bus as { on: typeof on }).on = (name, handler) => {
		if (name === event) {
			const frames = (new Error("registration site").stack ?? "")
				.split("\n")
				.map((line) => /\((.*?):\d+:\d+\)$|at (.*?):\d+:\d+$/.exec(line));
			const frame = frames
				.map((m) => m?.[1] ?? m?.[2] ?? "")
				.find((file) => file.includes("/src/octocode/") && !file.endsWith("/index.ts"));
			files.push(frame ?? "?");
		}
		on(name, handler);
	};
	await octocode(fake.api);
	fakeCtx({ cwd });
	return files;
}

describe("agent_settled handler order", () => {
	it("runs idle-items and the team's settle before the wake gate marks the session idle", async () => {
		const files = await registrants("agent_settled");
		const at = (name: string) => files.findIndex((file) => file.endsWith(name));
		const gate = at("/wake/register.ts");
		expect(gate).toBeGreaterThan(-1);
		// While the gate still counts the run as busy, the nudge and the settle-time mail trigger are never held, and
		// awaiting a held send cannot block `agent_settled`.
		expect(at("/subagents/idle-items.ts")).toBeGreaterThan(-1);
		expect(at("/subagents/idle-items.ts")).toBeLessThan(gate);
		const team = files.findIndex((file) => /\/team\//.test(file));
		expect(team).toBeGreaterThan(-1);
		expect(team).toBeLessThan(gate);
	});
});
