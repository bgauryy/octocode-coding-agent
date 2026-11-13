import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	alive,
	type Endpoint,
	killEverything,
	outputOfRuns,
	pidFrom,
	type Sandbox,
	sandbox,
	script,
	type Step,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";
import { enableHarnesses } from "./e2e-helpers/harness-toggles.ts";

/**
 * What only a real process shows: the tool registry the plan gate reads (fakes set `owner: "native"` for it), a signal
 * while a headless run holds for background work, a parent's flags reaching a real child, and the exit code a script reads.
 */
let endpoint: Endpoint;
let box: Sandbox;

// A source CLI start takes seconds, more on a busy machine, and a child is another one.
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

const fresh = () => {
	box = sandbox(endpoint);
	return box;
};
const requestsOf = (steps: readonly Step[]) => {
	const source = script(steps).slice("B64SCRIPT:".length);
	return endpoint.requests.filter((request) => request.script === source);
};
const lastResults = (steps: readonly Step[]) => requestsOf(steps).at(-1)?.toolResults ?? [];

describe("plan mode through the real tool registry", () => {
	it("lets the documented reads run and refuses writes", async () => {
		const { project, start } = fresh();
		const read = (tool: string, args: Record<string, unknown>): Step => ({ tool, args });
		const steps: Step[] = [
			read("bash", { command: "ls" }),
			read("askUser", { questions: [{ question: "Which?", options: [{ label: "a" }, { label: "b" }] }] }),
			read("archive", { op: "list" }),
			read("memory", { op: "list" }),
			read("skill", { name: "no-such-skill" }),
			// Loopback, so this never leaves the machine; the gate is what is under test, not what `web` answers.
			read("web", { url: endpoint.url }),
			read("mcp", { intent: "list" }),
			read("mcp", { intent: "stop", server: "octocode" }),
			read("memory", { op: "set", title: "A plan-mode save" }),
			read("file", { queries: [{ type: "write", path: "written.txt", content: "x" }] }),
			read("bash", { command: "echo x > redirected.txt" }),
			read("agent", { type: "task", goal: "no delegation", task: "no" }),
			{ text: "the plan" },
		];
		const run = start(["--plan", "-p", script(steps)]);
		const { code } = await run.exited;
		expect(code).toBe(0);
		const results = lastResults(steps);
		expect(results).toHaveLength(12);
		// `ls` really ran: its listing is the result.
		expect(results[0]).toContain("a.txt");
		for (const [index, name] of ["bash", "askUser", "archive", "memory", "skill", "web", "mcp list"].entries())
			expect(results[index], name).not.toContain("Plan mode blocks");
		for (const [index, name] of ["mcp stop", "memory set", "file", "bash redirect", "agent"].entries())
			expect(results[index + 7], name).toContain("Plan mode blocks");
		expect(fs.existsSync(path.join(project, "written.txt"))).toBe(false);
		expect(fs.existsSync(path.join(project, "redirected.txt"))).toBe(false);
		expect(run.stdout()).toContain("the plan");
	});
});

describe("a signal while a headless run holds for background work", () => {
	it("SIGTERM ends the hold, stops the child and exits 143", async () => {
		const { holdCommand, root, start, survivors } = fresh();
		const marker = path.join(root, "child.pid");
		const child: Step[] = [{ tool: "bash", args: { command: holdCommand(marker) } }, { text: "child done" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", background: true, goal: "sleep in a child", task: script(child) } },
			{ text: "waiting for the child" },
		];
		const run = start(["-p", script(parent)]);
		await until(() => fs.existsSync(marker), "the child's command");
		// The parent is in its hold: it has answered and its child still runs.
		await until(() => requestsOf(parent).length >= 2, "the parent's last turn");
		await new Promise((resolve) => setTimeout(resolve, 300));
		const command = pidFrom(marker);
		expect(alive(command)).toBe(true);

		run.process.kill("SIGTERM");
		const { code } = await run.exited;
		expect(code).toBe(143);
		await until(() => !alive(command), "the child's command to stop", 15_000);
		await until(() => survivors().length === 0, "every process of the run to stop", 15_000);
	});

	it("a timed bash job does not keep a signalled run alive", async () => {
		const { holdCommand, root, start } = fresh();
		const marker = path.join(root, "job.pid");
		const parent: Step[] = [
			{ tool: "bash", args: { command: holdCommand(marker), background: true, timeout: 280 } },
			{ text: "job started" },
		];
		const run = start(["-p", script(parent)]);
		await until(() => requestsOf(parent).length >= 2 && fs.existsSync(marker), "the job and the last turn");
		await new Promise((resolve) => setTimeout(resolve, 300));
		const job = pidFrom(marker);
		run.process.kill("SIGTERM");
		expect((await run.exited).code).toBe(143);
		await until(() => !alive(job), "the job to stop", 15_000);
	});

	it("a second signal exits at once while the first one's shutdown is still running", async () => {
		const { holdCommand, home, root, start } = fresh();
		const prompt = path.join(root, "prompt-hook.pid");
		const end = path.join(root, "session-end.pid");
		// A hook at the prompt's admission keeps the run from returning, which is what removes the signal handlers, and a
		// SessionEnd hook keeps the shutdown from finishing for as long as its own timeout (60 s). Claude Code's hook file
		// loads only with its harness switched on.
		const hook = (marker: string) => [{ hooks: [{ type: "command", command: holdCommand(marker), timeout: 60 }] }];
		enableHarnesses({ home }, "claude");
		fs.mkdirSync(path.join(home, ".claude"));
		fs.writeFileSync(
			path.join(home, ".claude", "settings.json"),
			JSON.stringify({ hooks: { UserPromptSubmit: hook(prompt), SessionEnd: hook(end) } }),
		);
		const run = start(["-p", script([{ text: "never asked" }])]);
		await until(() => fs.existsSync(prompt), "the prompt hook to start");
		run.process.kill("SIGTERM");
		await until(() => fs.existsSync(end), "the SessionEnd hook to start");
		// It really is stuck there, not on its way out.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(run.process.exitCode).toBeNull();
		expect(run.process.signalCode).toBeNull();
		const signalled = Date.now();
		run.process.kill("SIGTERM");
		expect((await run.exited).code).toBe(143);
		expect(Date.now() - signalled).toBeLessThan(10_000);
	});
});

describe("a parent's tool restrictions reach its children", () => {
	const childSteps = (name: string): Step[] => [
		{ tool: "bash", args: { command: `echo ${name} > ${name}.txt` } },
		{ text: "child done" },
	];
	const parentSteps = (child: readonly Step[]): Step[] => [
		{ tool: "agent", args: { type: "task", goal: "report what you can do", task: script(child) } },
		{ text: "parent done" },
	];

	it("--exclude-tools and --no-mcp hold in a child, over the specialist floor", async () => {
		const { project, start } = fresh();
		const child = childSteps("restricted");
		const parent = parentSteps(child);
		const run = start(["--exclude-tools", "bash,file", "--no-mcp", "-p", script(parent)]);
		expect((await run.exited).code).toBe(0);

		const parentTools = requestsOf(parent)[0]?.tools ?? [];
		expect(parentTools).not.toContain("bash");
		expect(parentTools).not.toContain("mcp");
		const childTools = requestsOf(child)[0]?.tools ?? [];
		expect(childTools).toContain("agent");
		for (const name of ["bash", "file", "mcp"]) expect(childTools, name).not.toContain(name);
		expect(childTools.filter((name) => name.startsWith("mcp__"))).toEqual([]);
		expect(fs.existsSync(path.join(project, "restricted.txt"))).toBe(false);
	});

	it("--tools stays the parent's own: a child keeps its profile's tools", async () => {
		const { start } = fresh();
		const child = childSteps("allowlist");
		const parent = parentSteps(child);
		const run = start(["--tools", "agent", "-p", script(parent)]);
		expect((await run.exited).code).toBe(0);
		expect(requestsOf(parent)[0]?.tools).not.toContain("bash");
		expect(requestsOf(child)[0]?.tools).toContain("bash");
	});
});

describe("what a script reads from a headless run", () => {
	it("the loop guard ends a run with exit 1 and says why", async () => {
		const { start } = fresh();
		const run = start(["-p", script([{ tool: "bash", args: { command: "ls" } }])]);
		const { code } = await run.exited;
		expect(run.stderr()).toContain("Loop guard ended this run");
		expect(code).toBe(1);
	});

	it("a failed command exits 1 and names the command", async () => {
		const { start } = fresh();
		const run = start(["-p", "/plan --approve 7"]);
		const { code } = await run.exited;
		expect(code).toBe(1);
		expect(run.stderr()).toContain("/plan");
		expect(run.stderr()).not.toContain("Extension error");
		expect(endpoint.requests).toHaveLength(0);
	});

	it("a failed command answers RPC with a failure, beside its event; a good one still answers success", async () => {
		const { start } = fresh();
		const run = start(["--mode", "rpc"], { stdin: "pipe" });
		const records = () =>
			run
				.stdout()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		const answer = (id: string) => records().find((record) => record.type === "response" && record.id === id);
		await until(() => records().some((record) => record.type === "rpc_ready"), "RPC to start");
		const send = (id: string, message: string) =>
			run.process.stdin?.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);

		send("failed", "/plan --approve 7");
		await until(() => answer("failed") !== undefined, "the failed command's answer");
		expect(answer("failed")).toMatchObject({ command: "prompt", success: false });
		expect(String(answer("failed")?.error)).toContain("revision");
		expect(records().some((record) => record.type === "extension_error" && record.event === "command")).toBe(true);

		send("good", "/plan --show");
		await until(() => answer("good") !== undefined, "the good command's answer");
		expect(answer("good")).toMatchObject({ success: true, data: { disposition: "handled" } });

		run.process.stdin?.end();
		expect((await run.exited).code).toBe(0);
		expect(endpoint.requests).toHaveLength(0);
	});

	it("a job stopped at run end leaves the answer alone and spends no request", async () => {
		const { holdCommand, root, start } = fresh();
		const steps: Step[] = [
			{ tool: "bash", args: { command: holdCommand(path.join(root, "job.pid")), background: true } },
			{ text: "the answer" },
			{ text: "a reply to the stopped job" },
		];
		const run = start(["-p", script(steps)]);
		const { code } = await run.exited;
		expect(code).toBe(0);
		expect(run.stdout().trim()).toBe("the answer");
		expect(requestsOf(steps)).toHaveLength(2);
	});
});

describe("isolate and merge", () => {
	it("an isolated child's write stays in its worktree until coordinate merge lands it", async () => {
		const { project, start } = fresh();
		const child: Step[] = [{ tool: "bash", args: { command: "echo isolated > isolated.txt" } }, { text: "child done" }];
		const parent: Step[] = [
			{ tool: "agent", args: { type: "task", isolate: true, goal: "write in a worktree", task: script(child) } },
			{ tool: "bash", args: { command: "ls" } },
			{ tool: "agent", args: { type: "coordinate", action: "merge", subagent: "{{CHILD}}" } },
			{ tool: "bash", args: { command: "ls" } },
			{ text: "parent done" },
		];
		const run = start(["-p", script(parent)]);
		expect((await run.exited).code).toBe(0);
		expect(requestsOf(child).length).toBeGreaterThan(0);
		const results = lastResults(parent);
		expect(results[1], "before the merge").not.toContain("isolated.txt");
		expect(results[3], JSON.stringify(results)).toContain("isolated.txt");
		expect(fs.readFileSync(path.join(project, "isolated.txt"), "utf8")).toBe("isolated\n");
	});
});
