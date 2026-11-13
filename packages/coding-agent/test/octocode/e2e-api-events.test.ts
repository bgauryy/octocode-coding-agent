import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTrust } from "./e2e-helpers/seed-trust.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	type Sandbox,
	sandbox,
	script,
	startEndpoint,
	type Step,
} from "./e2e-real-process-harness.ts";

/**
 * `octocode-api events` as another host runs it, after a real session ran a child to its end on a scripted model: its
 * own process, the sandbox's home, and no session running.
 */
let endpoint: Endpoint;
vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

const RESOLVER = fileURLToPath(new URL("../../scripts/source-resolver.ts", import.meta.url));
const API_CLI = fileURLToPath(new URL("../../src/octocode/api/cli.ts", import.meta.url));

function octocodeApi(box: Sandbox, args: string[]) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn(process.execPath, ["--no-warnings", "--import", RESOLVER, API_CLI, ...args], {
			cwd: box.project,
			env: box.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}

interface Page {
	since: number;
	last: number;
	events: Array<{ seq: number; event: string; agent: string; role?: string; parent?: string; reason?: string }>;
}

describe("octocode-api events", () => {
	it("shows a child's on and off with the reason, then nothing new after the last sequence", async () => {
		const box = sandbox(endpoint);
		seedTrust(box);
		const child: Step[] = [{ text: "done: nothing to do" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", goal: "end quickly", task: script(child) } },
			{ text: "read its report" },
		];
		expect((await box.start(["-p", script(parent)]).exited).code).toBe(0);

		const all = await octocodeApi(box, ["events", "--since", "0", "--json"]);
		expect(all.code, all.stderr).toBe(0);
		const page = JSON.parse(all.stdout) as Page;
		const main = page.events.find((event) => event.event === "on" && !event.parent);
		const on = page.events.find((event) => event.event === "on" && event.parent);
		expect(main, all.stdout).toBeDefined();
		expect(on, all.stdout).toMatchObject({ parent: main?.agent });
		const off = page.events.find((event) => event.event === "off" && event.agent === on?.agent);
		expect(off, all.stdout).toMatchObject({ reason: "completed", parent: main?.agent });
		expect(off!.seq).toBeGreaterThan(on!.seq);
		expect(page.last).toBe(page.events.at(-1)!.seq);

		const readable = await octocodeApi(box, ["events", "--since", "0"]);
		expect(readable.stdout).toMatch(new RegExp(`\\toff\\s*\\t${on!.agent}\\t.*reason=completed`));
		expect(readable.stdout.trim().split("\n").at(-1)).toBe(`last seq: ${page.last}`);

		const next = await octocodeApi(box, ["events", "--since", String(page.last), "--json"]);
		expect(next.code, next.stderr).toBe(0);
		expect(JSON.parse(next.stdout)).toEqual({ since: page.last, last: page.last, events: [] });
	});
});
