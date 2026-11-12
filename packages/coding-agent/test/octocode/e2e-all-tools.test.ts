import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LEAN_FLOOR } from "../../src/octocode/subagents/core-tools.ts";
import {
	alive,
	type Endpoint,
	killEverything,
	outputOfRuns,
	pidFrom,
	RESUMED_TEXT,
	type Sandbox,
	sandbox,
	script,
	type Step,
	writeSettings,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * Every tool, the browser and every subagent profile, in real processes (`e2e-real-process-harness.ts`): what a session
 * declares comes from the endpoint's recorded requests, so a tool nobody wrote a case for fails here instead of going
 * unproved. Nothing but the model is scripted. The GitHub and registry tools may reach the network or not, so their calls
 * only have to come back well formed; no case opens a visible browser, touches the clipboard or uploads.
 */
let endpoint: Endpoint;
let page: http.Server;
let pageUrl = "";

const PAGE = "<!doctype html><html><head><title>Loop Title</title></head><body><h1>loopback-marker</h1></body></html>";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const listen = (server: http.Server): Promise<number> =>
	new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

beforeAll(async () => {
	endpoint = await startEndpoint();
	page = http.createServer((request, response) => {
		if (request.url === "/page.html") return void response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		response.writeHead(404).end("nothing here");
	});
	pageUrl = `http://127.0.0.1:${await listen(page)}`;
});
afterEach((context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
});
afterAll(async () => {
	await killEverything();
	page.close();
	await endpoint.close();
});

const sourceOf = (steps: readonly Step[]) => script(steps).slice("B64SCRIPT:".length);
const requestsOf = (steps: readonly Step[]) => endpoint.requests.filter((one) => one.script === sourceOf(steps));
const lastResults = (steps: readonly Step[]) => requestsOf(steps).at(-1)?.toolResults ?? [];
const call = (tool: string, args: Record<string, unknown> = {}): Step => ({ tool, args });
const row = (extra: Record<string, unknown>) => ({ mainGoal: "prove the tool", reasoning: "scripted", ...extra });
const research = (tool: string, ...rows: Record<string, unknown>[]) =>
	call(`mcp__octocode__${tool}`, { queries: rows.map(row) });

/**
 * A sandbox with the research server on and a small TypeScript project the language server can resolve. The cases that
 * read each tool's typed signature from the prompt's `<mcps>` block run with `mcpPresentation: "compact"` (the default);
 * `declared`, the product default, is covered by the cases that pass `{}`.
 */
function repository(settings: Record<string, unknown> = { mcpPresentation: "compact" }): Sandbox {
	const box = sandbox(endpoint);
	writeSettings(box, settings);
	delete box.env.OCTOCODE_MCP;
	fs.mkdirSync(path.join(box.project, "src"));
	fs.writeFileSync(
		path.join(box.project, "src/math.ts"),
		"export interface Shape {\n\tarea(): number;\n}\n\nexport class Square implements Shape {\n\tconstructor(private readonly side: number) {}\n\tarea(): number {\n\t\treturn this.side * this.side;\n\t}\n}\n\nexport function addNumbers(a: number, b: number): number {\n\treturn a + b;\n}\n",
	);
	fs.writeFileSync(
		path.join(box.project, "src/main.ts"),
		'import { addNumbers, Square } from "./math.js";\n\nexport function total(): number {\n\treturn addNumbers(1, 2) + new Square(2).area();\n}\n',
	);
	fs.writeFileSync(
		path.join(box.project, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
			include: ["src"],
		}),
	);
	fs.writeFileSync(path.join(box.project, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
	return box;
}

interface Case {
	step: Step;
	check(result: string, box: Sandbox): void;
}
const answers = (step: Step, ...expected: (string | RegExp)[]): Case => ({
	step,
	check(result) {
		for (const one of expected) expect(result).toMatch(one);
	},
});

// The report starts with its outcome word, as a child's report must; without one the harness asks the child for it.
const CHILD_REPORT = "done: child-report-text";
const CHILD: Step[] = [call("bash", { command: "echo from-child" }), { text: CHILD_REPORT }];

/** The native tools, each with what proves a real effect or answer and what a failing call must say. */
const NATIVE: Record<string, { ok: Case[]; fail: Case[] }> = {
	bash: {
		ok: [
			{
				step: call("bash", { command: "echo bash-ok > bash-effect.txt && cat bash-effect.txt" }),
				check(result, box) {
					expect(result).toMatch(/^\[exit 0 /);
					expect(result).toContain("bash-ok");
					expect(fs.readFileSync(path.join(box.project, "bash-effect.txt"), "utf8")).toBe("bash-ok\n");
				},
			},
		],
		fail: [
			answers(call("bash", { command: "echo why >&2; exit 7" }), /^\[exit 7 /, "why"),
			answers(call("bash", { type: "powershell", command: "Get-Item ." }), "only available on Windows"),
		],
	},
	file: {
		ok: [
			answers(call("file", { queries: [{ type: "write", path: "w.txt", content: "first\n" }] }), "OK write w.txt"),
			answers(
				call("file", { queries: [{ type: "edit", path: "w.txt", edits: [{ oldText: "first", newText: "second" }] }] }),
				"OK edit w.txt",
			),
			{
				step: call("file", { patch: "*** Begin Patch\n*** Update File: w.txt\n@@\n-second\n+third\n*** End Patch" }),
				check(result, box) {
					expect(result).toContain("OK edit w.txt");
					expect(fs.readFileSync(path.join(box.project, "w.txt"), "utf8")).toBe("third\n");
				},
			},
			{
				step: call("file", {
					queries: [
						{ type: "write", path: "gone.txt", content: "x" },
						{ type: "delete", path: "gone.txt" },
					],
				}),
				check(result, box) {
					expect(result).toContain("OK delete gone.txt");
					expect(fs.existsSync(path.join(box.project, "gone.txt"))).toBe(false);
				},
			},
		],
		fail: [
			answers(
				call("file", { queries: [{ type: "edit", path: "missing.txt", edits: [{ oldText: "x", newText: "y" }] }] }),
				"FAILED edit missing.txt",
				"does not exist",
			),
			answers(call("file", { patch: "not a patch" }), "Invalid patch"),
		],
	},
	web: {
		// The URLs are this test's loopback page; `step` is filled in when the script is built.
		ok: [answers({ tool: "web", args: { url: "{{PAGE}}/page.html" } }, "loopback-marker", "Loop Title")],
		fail: [
			answers({ tool: "web", args: { url: "{{PAGE}}/missing" } }, "HTTP 404"),
			answers({ tool: "web", args: { url: "{{PAGE}}/page.html", query: "both" } }, "exactly one of url or query"),
		],
	},
	mcp: {
		ok: [
			answers(call("mcp", { intent: "list" }), /octocode: connected · \d+ tools/, "browser: not selected"),
			answers(call("mcp", { intent: "tools", server: "octocode", tool: "lspSearch" }), "lspSearch", '"required"'),
		],
		fail: [
			answers(call("mcp", { intent: "tools", server: "no-such" }), 'No MCP server "no-such"', "Servers: octocode"),
			answers(
				call("mcp", { intent: "tools", server: "octocode", tool: "no-such" }),
				'No available tool named "no-such"',
			),
		],
	},
	backlogPlan: {
		ok: [
			answers(
				call("backlogPlan", {
					op: "add",
					items: [{ title: "Prove it", goal: "It is proven", why: "because", paths: ["src/"], evidence: ["none"] }],
				}),
				"Added B1",
			),
			answers(
				call("backlogPlan", {
					op: "add",
					items: [{ title: "Close me", goal: "gone", why: "because", paths: ["a"], evidence: ["x"] }],
				}),
				"Added B2",
			),
			answers(call("backlogPlan", { op: "edit", items: [{ id: "B2", priority: "p1" }] }), "Updated B2 [backlog p1]"),
			answers(call("backlogPlan", { op: "list", states: ["backlog"] }), "B2 [backlog p1] Close me", "B1 [backlog p2]"),
		],
		fail: [
			answers(call("backlogPlan", { op: "add", items: [{ title: "No why" }] }), "add needs why"),
			answers(call("backlogPlan", { op: "list", tags: ["x"] }), "list does not take tags: use anyTag."),
		],
	},
	backlog: {
		ok: [
			answers(call("backlog", { op: "claim", id: "B1" }), "Updated B1 [ongoing"),
			answers(call("backlog", { op: "get", id: "B1" }), "Goal: It is proven", "Why: because"),
			answers(
				call("backlog", { op: "close", id: "B2", close: { kind: "obsolete", text: "no longer needed" } }),
				"Updated B2",
				"closed",
			),
			// One call, both items: each row is the full single `get`, separated by a rule.
			answers(
				call("backlog", { op: "get", ids: ["B1", "B2"] }),
				"Prove it",
				"Goal: It is proven",
				"Close me",
				"Goal: gone",
				"\n\n---\n",
			),
			// A missing id is reported on its own row and does not hide the others.
			answers(call("backlog", { op: "get", ids: ["B1", "B999"] }), "Goal: It is proven", "No backlog item B999"),
		],
		fail: [
			answers(call("backlog", { op: "get", id: "B999" }), "No backlog item B999"),
			// A call in the shape the tool had before `backlogPlan` passes validation and is told where it went.
			answers(call("backlog", { op: "list", states: ["todo"] }), 'call backlogPlan with op "list"'),
			answers(call("backlog", { op: "update", id: "B1", state: "done" }), 'backlog has no op "update": use op "done".'),
		],
	},
	timer: {
		// Far enough ahead that it never wakes this run; the cancel ends it before the session does.
		ok: [
			answers(
				call("timer", { op: "set", after: 3600, note: "timer-marker" }),
				/^Set 1 · once · next wake in 3600s · timer-marker/,
			),
			answers(call("timer", { op: "list" }), /^1 · once · next wake in \d+s · timer-marker$/),
			answers(call("timer", { op: "cancel", id: 1 }), /^Cancelled 1 · once · cancelled/),
			answers(call("timer", { op: "list" }), "No active timers."),
			// As clearTimeout: cancelling a timer that already ended is a no-op, not an error.
			answers(call("timer", { op: "cancel", id: 1 }), /^Timer 1 already ended, nothing to cancel/),
		],
		fail: [
			answers(call("timer", { op: "set", after: 60 }), "set needs a note"),
			answers(call("timer", { op: "cancel", id: 99 }), "No timer 99 in this session. No timer is active."),
		],
	},
	archive: {
		ok: [
			answers(call("archive", { op: "list", source: "events" }), /events: \d+ records/),
			answers(call("archive", { op: "search", source: "sessions", keywords: "bash-effect" }), "sessions:"),
		],
		fail: [
			// Memories were this tool's until `memory` became its own: an old call is refused with the call to make.
			answers(
				call("archive", { op: "set", source: "sessions", title: "x" }),
				'archive no longer reads or writes memories: call the memory tool with op "set".',
			),
			answers(
				call("archive", { op: "get", id: "M999", source: "memories" }),
				'archive no longer reads or writes memories: call the memory tool with op "get".',
			),
		],
	},
	memory: {
		ok: [
			answers(
				call("memory", { op: "set", title: "A rule", body: "Keep it", keywords: "rule marker" }),
				"Saved M1",
				"Keep it",
			),
			answers(call("memory", { op: "search", keywords: "rule" }), "M1", "A rule"),
			answers(call("memory", { op: "list" }), "M1", "A rule"),
			answers(call("memory", { op: "get", id: "M1" }), "Keep it"),
			answers(call("memory", { op: "delete", id: "M1" }), "M1"),
		],
		fail: [
			answers(call("memory", { op: "get", id: "M999" }), "No memory M999"),
			answers(call("memory", { op: "search" }), "Memory search needs query or keywords."),
		],
	},
	askUser: {
		// Headless is the refusal: nobody can answer, and the model is told what follows from that. The answer path is below.
		ok: [
			answers(
				call("askUser", { questions: [{ question: "Which?", options: [{ label: "a" }, { label: "b" }] }] }),
				"No interactive user is available",
				"No answer or approval was supplied",
			),
		],
		fail: [answers(call("askUser", { questions: [] }), "Ask at least one question")],
	},
	skill: {
		ok: [
			answers(
				call("skill", { name: "octocode-debugging" }),
				'<skill name="octocode-debugging"',
				"# Octocode Debugging",
			),
		],
		fail: [answers(call("skill", { name: "no-such-skill" }), 'Unknown skill "no-such-skill"', "octocode-debugging")],
	},
	models: {
		ok: [
			answers(
				call("models"),
				"This session: scripted/model",
				"scripted · local · models.json · 1 runnable",
				"Profiles:",
			),
			answers(call("models", { provider: "scripted" }), "● scripted/model", "Profiles:"),
		],
		fail: [answers(call("models", { ability: "nonsense" }), 'Validation failed for tool "models"', "ability")],
	},
	compact: {
		// The success needs a full context, so it has its own run below.
		ok: [],
		fail: [answers(call("compact"), "Compaction refused", "under 50%")],
	},
	agent: {
		ok: [
			answers(
				call("agent", { type: "task", goal: "run one command", task: script(CHILD) }),
				CHILD_REPORT,
				/Subagent \S+ reported done/,
			),
			answers(call("agent", { type: "coordinate", action: "join", joinGoal: "prove it" }), "goal: prove it"),
			answers(call("agent", { type: "coordinate", action: "list" }), "(you)", "main"),
			answers(call("agent", { type: "coordinate", action: "lock", paths: ["src/math.ts"] }), "Reserved: src/math.ts"),
			answers(call("agent", { type: "coordinate", action: "unlock", paths: ["src/math.ts"] }), "Released 1"),
			answers(call("agent", { type: "coordinate", action: "changes" }), "bash-effect.txt", "w.txt"),
			answers(call("agent", { type: "coordinate", action: "leave" }), "Left the team"),
			answers(call("agent", { type: "coordinate", action: "join" }), "(you)"),
		],
		fail: [
			answers(call("agent", { type: "task", goal: "no task field" }), "Invalid agent task call", "task"),
			answers(
				call("agent", { type: "task", profile: "no-such", goal: "x", task: "x" }),
				'Unknown profile "no-such"',
				"researcher",
			),
			answers(
				call("agent", { type: "task", model: "no/such", goal: "x", task: "x" }),
				'Model "no/such" is not available',
			),
			answers(call("agent", { type: "task", skills: ["no-such"], goal: "x", task: "x" }), 'skill "no-such"'),
			answers(call("agent", { type: "task", resume: "no-such", goal: "x", task: "x" }), 'No subagent "no-such"'),
			answers(
				call("agent", { type: "coordinate", action: "merge", subagent: "no-such" }),
				"No isolated changes for no-such",
			),
			answers(
				call("agent", { type: "coordinate", action: "stop", subagent: "no-such" }),
				'No background subagent "no-such"',
			),
			answers(
				call("agent", { type: "message", to: "{{CHILD}}", message: "too late" }),
				"has finished and takes no more messages",
			),
			answers(
				call("agent", { type: "message", to: "no-such-agent", message: "hello?" }),
				'No live agent "no-such-agent"',
			),
		],
	},
};

describe("every native tool, in one real process", () => {
	const flat = Object.entries(NATIVE).flatMap(([tool, { ok, fail }]) =>
		[...ok, ...fail].map((one) => ({ tool, ...one })),
	);
	const withPage = (step: Step): Step => JSON.parse(JSON.stringify(step).replaceAll("{{PAGE}}", pageUrl)) as Step;
	let box: Sandbox;
	let steps: Step[];
	let code: number | null;
	let stdout = "";

	beforeAll(async () => {
		box = repository();
		steps = [...flat.map(({ step }) => withPage(step)), { text: "parent-final-text" }];
		const run = box.start(["-p", script(steps)]);
		({ code } = await run.exited);
		stdout = run.stdout();
	});

	it("declares nothing without a case, and no case for what it does not declare", () => {
		const declared = requestsOf(steps)[0]?.tools.filter((name) => !name.startsWith("mcp__")) ?? [];
		expect([...declared].sort()).toEqual(Object.keys(NATIVE).sort());
	});

	it("survives every failing call and ends with the model's answer", () => {
		expect(code).toBe(0);
		expect(stdout.trim()).toBe("parent-final-text");
		expect(lastResults(steps)).toHaveLength(flat.length);
	});

	it.each(Object.keys(NATIVE))("%s: each call has its effect, each failure says why", (tool) => {
		const results = lastResults(steps);
		flat.forEach((one, index) => {
			if (one.tool !== tool) return;
			expect(results[index], JSON.stringify(one.step)).toBeDefined();
			one.check(results[index], box);
		});
	});

	it("the child behind the agent call really ran its tool", () => {
		expect(lastResults(CHILD)[0]).toContain("from-child");
	});
});

describe("the native paths that need a run of their own", () => {
	it("compact: a full context is summarized when the reply ends, and the task resumes from the summary", async () => {
		const box = sandbox(endpoint);
		const big = { command: "head -c 24000 /dev/zero | tr '\\0' 'x'" };
		const full = { promptTokens: 100_000 };
		const steps: Step[] = [
			...Array.from({ length: 6 }, (_, index): Step => ({
				tool: "bash",
				args: { command: `${big.command}; echo ${index}` },
				...full,
			})),
			{ tool: "compact", args: { focus: "keep the marker" }, ...full },
			{ text: "queued-status" },
		];
		const run = box.start(["-p", script(steps)]);
		expect((await run.exited).code).toBe(0);
		expect(lastResults(steps).find((result) => result.startsWith("Compaction queued"))).toBeDefined();
		const summaryRequest = endpoint.requests.find((one) => one.lastUserText.includes("context checkpoint summary"));
		expect(summaryRequest?.lastUserText, "the summary request carries the focus").toContain("keep the marker");
		const sessionFile = /recorded in (\S+\.jsonl)/.exec(run.stderr())?.[1] ?? "";
		const entries = fs
			.readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; summary?: string });
		const compaction = entries.find((entry) => entry.type === "compaction");
		expect(compaction?.summary).toContain("scripted summary");
		// The task resumed: the answer is the turn after the compaction, not the status line that asked for it.
		expect(run.stdout().trim()).toBe(RESUMED_TEXT);
		const resumed = requestsOf(steps)
			.at(-1)
			?.messages.map((message) => message.text)
			.join("\n");
		expect(resumed).toContain("scripted summary");
	});

	it("askUser: over RPC the question reaches the client and its answer reaches the model", async () => {
		const box = sandbox(endpoint);
		const steps: Step[] = [
			call("askUser", { questions: [{ question: "Which?", options: [{ label: "a" }, { label: "b" }] }] }),
			{ text: "answered" },
		];
		const run = box.start(["--mode", "rpc"], { stdin: "pipe" });
		// Only complete lines: the process may be mid-write of a long record, so the text after the last newline is
		// not yet JSON (a parse of it made this test flaky under load).
		const records = () =>
			run
				.stdout()
				.split("\n")
				.slice(0, -1)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		await until(() => records().some((one) => one.type === "rpc_ready"), "RPC to start");
		run.process.stdin?.write(`${JSON.stringify({ id: "p", type: "prompt", message: script(steps) })}\n`);
		const question = () => records().find((one) => one.type === "extension_ui_request" && one.method === "select");
		await until(() => question() !== undefined, "the question");
		const options = question()?.options as string[];
		expect(question()?.title).toBe("Which?");
		const answer = options.find((option) => option.endsWith("b"));
		run.process.stdin?.write(
			`${JSON.stringify({ type: "extension_ui_response", id: question()?.id, value: answer })}\n`,
		);
		await until(() => lastResults(steps).length > 0, "the model to get the answer");
		expect(lastResults(steps)[0]).toMatch(/\bb\b/);
		expect(lastResults(steps)[0]).not.toContain("Cancelled");
		run.process.stdin?.end();
		await expectCleanRun(run);
	});

	it("agent: coordinate stop ends a background child and everything it runs", async () => {
		const box = sandbox(endpoint);
		const marker = path.join(box.root, "held.pid");
		const child: Step[] = [call("bash", { command: box.holdCommand(marker) }), { text: "never" }];
		const steps: Step[] = [
			call("agent", { type: "task", background: true, goal: "hold until stopped", task: script(child) }),
			call("bash", { command: `until [ -f ${JSON.stringify(marker)} ]; do sleep 0.1; done` }),
			call("agent", { type: "coordinate", action: "stop", subagent: "{{CHILD}}" }),
			{ text: "stopped" },
		];
		const run = box.start(["-p", script(steps)]);
		expect((await run.exited).code).toBe(0);
		expect(lastResults(steps)[2]).toMatch(/Stopping \S+/);
		const held = pidFrom(marker);
		await until(() => !alive(held), "the child's command to stop", 15_000);
		await until(() => box.survivors().length === 0, "every process of the run to stop", 15_000);
	});
});

/**
 * One rendered tool's block in the prompt's `<mcps>` section. A type the renderer hoists because several tools share it
 * (`} & QueriesVariants)[]`, `type QueriesVariants = …;` once per server) is written back in place, so the block reads
 * as one signature.
 */
function toolBlock(system: string, tool: string): string {
	const start = system.indexOf(`function ${tool}(input:`);
	expect(start, `${tool} is rendered`).toBeGreaterThanOrEqual(0);
	const block = system.slice(start, system.indexOf("}): unknown;", start));
	return block.replace(/&\s*([A-Z]\w*)\b/g, (whole, name: string) => {
		const body = hoistedType(system, name);
		return body === undefined ? whole : `& (${body})`;
	});
}

/** The right-hand side of `type <name> = …;` in the prompt, up to its closing `;` outside brackets and comments. */
function hoistedType(system: string, name: string): string | undefined {
	const head = `type ${name} = `;
	const from = system.indexOf(head);
	if (from < 0) return undefined;
	let depth = 0;
	for (let at = from + head.length; at < system.length; at++) {
		if (system.startsWith("/*", at)) {
			at = system.indexOf("*/", at + 2) + 1;
			if (at <= 0) return undefined;
			continue;
		}
		const char = system[at];
		if ("{[(".includes(char)) depth++;
		else if ("}])".includes(char)) depth--;
		else if (char === ";" && depth === 0) return system.slice(from + head.length, at);
	}
	return undefined;
}

interface Field {
	name: string;
	optional: boolean;
	type: string;
}

/** The fields of an object type's text, at its top level. */
function fieldsOf(text: string): Field[] {
	const fields: Field[] = [];
	let depth = 0;
	let token = "";
	for (const char of text) {
		if ("{[(".includes(char)) depth++;
		if ("}])".includes(char)) depth--;
		if (depth === 0 && char === ";") {
			const match = /^\s*(\w+)(\?)?:\s*([\s\S]*)$/.exec(token);
			if (match) fields.push({ name: match[1], optional: match[2] === "?", type: match[3].trim() });
			token = "";
		} else token += char;
	}
	return fields;
}

/** The text between the bracket at `from` and the one that closes it. */
function balanced(text: string, from: number): string {
	let depth = 0;
	for (let at = from; at < text.length; at++) {
		if ("{[(".includes(text[at])) depth++;
		if ("}])".includes(text[at]) && --depth === 0) return text.slice(from + 1, at);
	}
	return text.slice(from + 1);
}

/** What a rendered query row offers: the shared fields, and each form's selector values and fields of its own. */
function rowForms(block: string): {
	shared: Field[];
	forms: { values: string[]; selector: string; fields: Field[] }[];
} {
	const plain = block.replace(/\/\*[\s\S]*?\*\//g, "");
	const row = balanced(plain, plain.indexOf("queries?: (") + "queries?: ".length);
	const sharedText = balanced(row, row.indexOf("{"));
	const rest = row.slice(row.indexOf(sharedText) + sharedText.length);
	const union = balanced(rest, rest.indexOf("("));
	const forms: { values: string[]; selector: string; fields: Field[] }[] = [];
	for (let at = union.indexOf("{"); at >= 0; at = union.indexOf("{", at + balanced(union, at).length + 2)) {
		const fields = fieldsOf(balanced(union, at));
		const selector = fields.find((field) => field.type.startsWith('"')) ?? fields[0];
		forms.push({
			selector: selector?.name ?? "",
			values: [...(selector?.type ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]),
			fields,
		});
	}
	return { shared: fieldsOf(sharedText), forms };
}

const LSP_ANCHOR = { path: "src/math.ts", symbolName: "addNumbers", line: 12 };

/** A row the rendered signature allows for each selector value of the local tools. */
const LOCAL_ROWS: Record<string, Record<string, Record<string, unknown>>> = {
	localSearch: Object.fromEntries(
		["content", "files", "filesWithout", "countLines", "countMatches", "matchOnly"].map((view) => [
			view,
			{ path: ".", matchString: ["addNumbers"], view },
		]),
	),
	localFetch: Object.fromEntries(
		["content", "compact", "symbols"].map((view) => [view, { path: "src/math.ts", view }]),
	),
	structureSearch: {
		tree: { path: ".", operation: "tree" },
		files: { path: ".", operation: "files", extensions: ["ts"] },
	},
	astSearch: {
		match: { path: "src", operation: "match", rule: { pattern: "addNumbers($$$)" } },
		syntaxTree: { path: "src/math.ts", operation: "syntaxTree", line: 12 },
		symbols: { path: "src", operation: "symbols" },
	},
	lspSearch: {
		definition: { operation: "definition", path: "src/main.ts", symbolName: "addNumbers", line: 4 },
		typeDefinition: { operation: "typeDefinition", path: "src/main.ts", symbolName: "total", line: 3 },
		implementation: { operation: "implementation", path: "src/math.ts", symbolName: "Shape", line: 1 },
		references: { operation: "references", ...LSP_ANCHOR },
		callers: { operation: "callers", ...LSP_ANCHOR },
		callees: { operation: "callees", path: "src/main.ts", symbolName: "total", line: 3 },
		supertypes: { operation: "supertypes", path: "src/math.ts", symbolName: "Square", line: 5 },
		subtypes: { operation: "subtypes", path: "src/math.ts", symbolName: "Shape", line: 1 },
		hover: { operation: "hover", ...LSP_ANCHOR },
		documentSymbols: { operation: "documentSymbols", path: "src/math.ts" },
		diagnostic: { operation: "diagnostic", path: "src/main.ts" },
		workspaceSymbol: { operation: "workspaceSymbol", symbolQuery: "addNum", path: "." },
	},
};

const REFUSED_FOR_SHAPE = /Validation failed|not allowed in this form|unexpected property|errorCode":"invalidInput/;

/** What each local tool's first row must find in the fixture, and a call the server must refuse usefully. */
const LOCAL_ANSWERS: Record<string, { found: Record<string, string>; fail: Record<string, unknown>; says: string }> = {
	localSearch: { found: { content: "export function addNumbers" }, fail: { path: "." }, says: "matchString" },
	localFetch: { found: { content: "export function addNumbers" }, fail: { path: "src/none.ts" }, says: "pathNotFound" },
	structureSearch: { found: { files: "math.ts", tree: "src/" }, fail: { path: "nowhere" }, says: "pathNotFound" },
	astSearch: {
		found: { match: "addNumbers(1, 2)", symbols: "addNumbers" },
		fail: { path: "src", operation: "match" },
		says: "rule",
	},
	lspSearch: {
		found: {
			definition: "src/math.ts",
			implementation: "class Square",
			references: "addNumbers(1, 2)",
			callers: '"symbolName":"total"',
			callees: '"symbolName":"Square"',
			supertypes: '"symbolName":"Shape"',
			subtypes: '"symbolName":"Square"',
			hover: "function addNumbers",
			documentSymbols: '"symbolName":"Square"',
			workspaceSymbol: '"symbolName":"addNumbers"',
		},
		fail: { path: "src/main.ts", symbolName: "addNumbers" },
		says: "line",
	},
};

/** A run that exits 0 and, when `stdout` is given, prints exactly it. Named so its assertions work from a hook. */
async function expectCleanRun(run: ReturnType<Sandbox["start"]>, stdout?: string): Promise<void> {
	expect((await run.exited).code).toBe(0);
	if (stdout !== undefined) expect(run.stdout().trim()).toBe(stdout);
}

describe("the Octocode research tools against the real server", () => {
	let box: Sandbox;
	let steps: Step[];
	const expected: { tool: string; value: string; index: number }[] = [];
	const failing: { tool: string; index: number }[] = [];

	beforeAll(async () => {
		// Every research tool rendered in full: the default defers a tool this folder never called.
		box = repository({ mcpPresentation: "compact", mcpExposure: "direct" });
		steps = [];
		for (const [tool, rows] of Object.entries(LOCAL_ROWS)) {
			for (const [value, one] of Object.entries(rows)) {
				expected.push({ tool, value, index: steps.length });
				steps.push(research(tool, one));
			}
			failing.push({ tool, index: steps.length });
			steps.push(research(tool, LOCAL_ANSWERS[tool].fail));
		}
		steps.push({ text: "research-done" });
		const run = box.start(["-p", script(steps)]);
		await expectCleanRun(run, "research-done");
	});

	const system = () => requestsOf(steps)[0]?.system ?? "";
	const declared = () => requestsOf(steps)[0]?.tools.filter((name) => name.startsWith("mcp__octocode__")) ?? [];

	it("a declared tool with no case fails here", () => {
		const covered = new Set([...Object.keys(LOCAL_ROWS), ...Object.keys(REMOTE)]);
		expect(
			declared()
				.map((name) => name.slice("mcp__octocode__".length))
				.filter((name) => !covered.has(name)),
		).toEqual([]);
		expect(declared().length).toBeGreaterThanOrEqual(12);
	});

	it.each(Object.keys(LOCAL_ROWS))(
		"%s: every selector value in its signature has a row, and every row names real fields",
		(tool) => {
			const block = toolBlock(system(), tool);
			const { forms } = rowForms(block);
			const values = forms.flatMap((form) => form.values);
			expect(values.filter((value) => !(value in LOCAL_ROWS[tool]))).toEqual([]);
			expect(Object.keys(LOCAL_ROWS[tool]).filter((value) => !values.includes(value))).toEqual([]);
			for (const one of Object.values(LOCAL_ROWS[tool]))
				for (const key of Object.keys(one)) expect(block, key).toMatch(new RegExp(`\\b${key}\\??:`));
		},
	);

	// Exposure smoke test: the external server behind each exposed tool answers; its result format is its own contract.
	it.each(Object.keys(LOCAL_ROWS))("%s: the exposed tool reaches the server and every row gets results", (tool) => {
		for (const { tool: name, value, index } of expected) {
			if (name !== tool) continue;
			const result = lastResults(steps)[index] ?? "";
			expect(result, `${tool} ${value}`).not.toMatch(REFUSED_FOR_SHAPE);
			expect(result, `${tool} ${value}`).toContain('"results"');
			// Without a language server (a bare CI image) lspSearch answers so.
			const answered = tool !== "lspSearch" || result.includes('"serverAvailable":true');
			const found = LOCAL_ANSWERS[tool].found[value];
			if (found && answered) expect(result, `${tool} ${value}`).toContain(found);
		}
	});

	it.each(Object.keys(LOCAL_ROWS))(
		"%s: exposure smoke: a bad call comes back with the field or cause named",
		(tool) => {
			const at = failing.find((one) => one.tool === tool)?.index ?? -1;
			expect(lastResults(steps)[at]).toContain(LOCAL_ANSWERS[tool].says);
		},
	);

	it("mcp stop takes a server's tools away with a clear error and restart brings them back", async () => {
		const stopSteps: Step[] = [
			call("mcp", { intent: "stop", server: "octocode" }),
			research("localFetch", { path: "src/math.ts" }),
			call("mcp", { intent: "restart", server: "octocode" }),
			research("localFetch", { path: "src/math.ts", view: "symbols" }),
			{ text: "restarted" },
		];
		const run = repository().start(["-p", script(stopSteps)]);
		expect((await run.exited).code).toBe(0);
		const results = lastResults(stopSteps);
		expect(results[0]).toContain("octocode: stopped");
		expect(results[1]).toContain("not active in this session");
		expect(results[2]).toMatch(/octocode: connected · \d+ tools/);
		expect(results[3]).toContain("addNumbers");
	});

	it("the host refuses too many rows and a bad cursor with what to do instead", async () => {
		const shapeSteps: Step[] = [
			call("mcp__octocode__localSearch", {
				queries: Array.from({ length: 6 }, () => ({ path: ".", matchString: ["x"] })),
			}),
			call("mcp__octocode__localSearch", { cursor: "bogus" }),
			call("mcp__octocode__localSearch", {}),
			{ text: "done" },
		];
		const run = repository().start(["-p", script(shapeSteps)]);
		expect((await run.exited).code).toBe(0);
		const results = lastResults(shapeSteps);
		expect(results[0]).toContain("holds at most 5");
		expect(results[1]).toContain("Malformed cursor");
		expect(results[2]).toContain('{\\"queries\\":[...]}');
	});
});

/** A call each tool that needs the network or a token refuses by its form, before any request. */
const OWNER = { owner: "bgauryy", repo: "octocode" };
const REMOTE: Record<string, { refused: Record<string, unknown>; says: RegExp }> = {
	ghSearchCode: {
		refused: { owner: "bgauryy", query: "not a field" },
		says: /query/,
	},
	ghGetFileContent: {
		refused: { ...OWNER },
		says: /path/,
	},
	ghStructure: {
		refused: { ...OWNER, operation: "languages", maxDepth: 1 },
		says: /maxDepth/,
	},
	ghSearchRepo: {
		refused: { owner: "bgauryy", operation: "get" },
		says: /repo/,
	},
	ghSearchHistory: {
		refused: { ...OWNER, operation: "issue", path: "README.md" },
		says: /path/,
	},
	ghGetHistoryItem: {
		refused: { ...OWNER, operation: "issue", number: 1, ref: "HEAD" },
		says: /ref/,
	},
	ghCloneRepo: {
		refused: { ...OWNER, historyDepth: 0 },
		says: /historyDepth/,
	},
	artifactSearch: {
		refused: { ecosystem: "npm", operation: "resolve", packageName: "left-pad", keywords: ["x"] },
		says: /keywords/,
	},
};

describe("the tools that need a token or the network", () => {
	it("a form-breaking call is refused before any request, naming the field", async () => {
		const steps: Step[] = [
			...Object.entries(REMOTE).map(([tool, { refused }]) => research(tool, refused)),
			{ text: "refused" },
		];
		const run = repository().start(["-p", script(steps)]);
		expect((await run.exited).code).toBe(0);
		const results = lastResults(steps);
		Object.entries(REMOTE).forEach(([tool, { says }], index) => {
			expect(results[index], tool).toMatch(says);
			expect(results[index], tool).toMatch(REFUSED_FOR_SHAPE);
		});
	});
});

const ROLES = fileURLToPath(new URL("../../src/octocode/instructions/roles/", import.meta.url));

interface Role {
	name: string | undefined;
	tools: string[] | undefined;
	skills: string[];
	readOnly: boolean;
	lean: boolean;
	firstLine: string | undefined;
}

/**
 * One profile of each kind, as its file declares it: a read-only one, a lean one and a child with no profile. The other
 * bundled profiles differ only in prose and tool lists, which the in-process profile, role-skill and prompt tests read.
 */
const RUN_PROFILES = ["reviewer", "lean"];
const profiles: Role[] = [
	...RUN_PROFILES.map((name) => `${name}.md`).map((file): Role => {
		const [, head = "", body = ""] =
			/^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(fs.readFileSync(path.join(ROLES, file), "utf8")) ?? [];
		const field = (name: string) => new RegExp(`^${name}: (.+)$`, "m").exec(head)?.[1]?.trim();
		return {
			name: field("name"),
			tools: field("tools")?.split(","),
			// `skills: []` declares none; a bare list is comma separated.
			skills: (field("skills") ?? "")
				.replace(/^\[|\]$/g, "")
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean),
			readOnly: field("readOnly") === "true",
			lean: field("lean") === "true",
			firstLine: body.trim().split("\n")[0],
		};
	}),
	{ name: undefined, tools: undefined, skills: [], readOnly: false, lean: false, firstLine: undefined },
];

const glob = (selector: string) => new RegExp(`^${selector.replaceAll("*", ".*")}$`);

describe("every subagent profile, started through agent", () => {
	const label = (role: Role) => role.name ?? "no-profile";
	const childOf = (role: Role): Step[] => [
		// Read-only roles may still read, and every role here can run a shell command.
		call("bash", { command: `echo ran-${label(role)}` }),
		...(role.lean
			? []
			: [
					role.readOnly
						? research("localSearch", { path: ".", matchString: ["addNumbers"] })
						: call("file", { queries: [{ type: "write", path: `by-${label(role)}.txt`, content: "x" }] }),
				]),
		...(role.readOnly
			? [call("file", { queries: [{ type: "write", path: `ro-${label(role)}.txt`, content: "x" }] })]
			: []),
		call("agent", { type: "message", to: "parent", message: `note-from-${label(role)}` }),
		{ text: `report-of-${label(role)}` },
	];
	let box: Sandbox;
	let parent: Step[];

	beforeAll(async () => {
		box = repository();
		parent = [
			...profiles.map((role) =>
				call("agent", {
					type: "task",
					goal: `run as ${label(role)}`,
					task: script(childOf(role)),
					...(role.name ? { profile: role.name } : {}),
				}),
			),
			{ text: "parent-final-text" },
		];
		const run = box.start(["-p", script(parent)]);
		await expectCleanRun(run);
	});

	it("covers a read-only, a lean and a profile-less child", () => {
		expect(profiles.map(label).sort()).toEqual(["lean", "no-profile", "reviewer"]);
		expect(profiles.map((role) => [role.readOnly, role.lean])).toEqual([
			[true, false],
			[false, true],
			[false, false],
		]);
	});

	it.each(profiles.map((role) => [label(role), role] as const))(
		"%s starts, has its tools, role and skills, works and reports",
		(name, role) => {
			const requests = requestsOf(childOf(role));
			expect(requests.length, "the child reached the model").toBeGreaterThan(0);
			const first = requests[0];
			// The tools its profile declares; an exact name the server does not offer here (`clasify` needs a key) is not one.
			const offered = new Set(requestsOf(parent)[0]?.tools);
			for (const selector of role.tools ?? []) {
				const matched = first.tools.filter((tool) => glob(selector).test(tool));
				if (selector.includes("*") || !selector.startsWith("mcp__") || offered.has(selector))
					expect(matched.length, `${name} has ${selector}`).toBeGreaterThan(0);
			}
			if (role.lean) {
				// Its own list plus the floor every lean child keeps (`core-tools.ts`).
				expect([...first.tools].sort()).toEqual([...new Set([...(role.tools ?? []), ...LEAN_FLOOR])].sort());
				expect(first.system).not.toContain("<available_skills>");
			}
			// Its role section and role skills are in the prompt the model got; a child with no profile has neither.
			if (role.firstLine) {
				const section = first.system.slice(first.system.indexOf("<role>"), first.system.indexOf("</role>"));
				expect(section).toContain(role.firstLine);
				for (const skill of role.skills) expect(section, skill).toContain(`<skill name="${skill}"`);
			} else expect(first.system).not.toContain("<role>");
			expect(first.lastUserText).toContain(`(${role.name ?? "general"})`);
			// Its tool calls ran.
			const results = requests.at(-1)?.toolResults ?? [];
			expect(results[0]).toContain(`ran-${name}`);
			if (role.readOnly) {
				expect(results[1]).toContain("addNumbers");
				expect(results[2]).toContain("this is a read-only role");
				expect(fs.existsSync(path.join(box.project, `ro-${name}.txt`))).toBe(false);
			} else if (!role.lean) expect(fs.readFileSync(path.join(box.project, `by-${name}.txt`), "utf8")).toBe("x");
			// Its message reached the parent, and so did its report.
			expect(results.at(-1)).toContain("Queued message");
			const reachedParent = requestsOf(parent)
				.at(-1)
				?.messages.map((message) => message.text)
				.join("\n");
			expect(reachedParent).toContain(`note-from-${name}`);
			expect(lastResults(parent).join("\n")).toContain(`report-of-${name}`);
		},
	);

	it("the run leaves no process behind", () => {
		expect(box.survivors()).toEqual([]);
	});
});

const freePort = async (): Promise<number> => {
	const probe = http.createServer();
	const port = await listen(probe);
	await new Promise((resolve) => probe.close(resolve));
	return port;
};

const waitFor = (file: string) => `until [ -f ${JSON.stringify(file)} ]; do sleep 0.1; done`;

const chromeOn = (port: number): string[] =>
	execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" })
		.split("\n")
		.filter((line) => line.includes(`--remote-debugging-port=${port}`) && !line.includes("--type="));

const killChromeOn = (port: number): void => {
	for (const line of chromeOn(port)) {
		try {
			process.kill(Number.parseInt(line.trim(), 10), "SIGKILL");
		} catch {
			// Already gone.
		}
	}
};

/** The JSON of a browser result, past the untrusted-text wrapper. */
function browserData(result: string | undefined): Record<string, any> {
	const start = result?.indexOf('{"ok"') ?? -1;
	if (!result || start < 0) return {};
	return JSON.parse(result.slice(start).split("\n", 1)[0]) as Record<string, any>;
}

describe("the browser, for real: headless Chrome on an isolated profile against a loopback page", () => {
	/** Why Chrome or its server cannot run here, in their own words; anything else is a failure of the case, not a skip. */
	const unavailable = (tools: readonly string[] | undefined, open: string | undefined): string | undefined => {
		if (!tools?.includes("mcp__browser__open")) return "the browser server did not start: its tools were not declared";
		return open?.includes("Chrome not found") ? open.slice(0, 400) : undefined;
	};

	it("opens it, reads the DOM, takes a screenshot and closes it", async (context) => {
		const box = repository();
		const port = await freePort();
		const connection = { port };
		const requested = path.join(box.root, "page-requested");
		const loaded = http.createServer((_request, response) => {
			fs.writeFileSync(requested, "");
			response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		});
		const url = `http://127.0.0.1:${await listen(loaded)}/page.html`;
		const child: Step[] = [
			call("mcp__browser__snapshot", { connection }),
			call("mcp__browser__open", { url, headless: true, port }),
			call("mcp__browser__run", { connection, plan: { steps: [{ op: "nonsense" }] } }),
			// The page has loaded, not just the browser opened.
			call("bash", { command: waitFor(requested) }),
			call("mcp__browser__snapshot", { connection, options: { SNAPSHOT_TEXT: 500 } }),
			call("mcp__browser__run", { connection, plan: { steps: [{ op: "extract", selector: "h1", fields: ["text"] }] } }),
			call("mcp__browser__screenshot", { connection }),
			call("mcp__browser__cleanup", { port }),
			call("agent", { type: "message", to: "parent", message: "browser-note" }),
			{ text: "browser-report" },
		];
		const parent: Step[] = [
			call("agent", { type: "task", profile: "browser", headless: true, goal: "drive the page", task: script(child) }),
			{ text: "parent-final" },
		];
		const run = box.start(["-p", script(parent)]);
		const seen = new Set<string>();
		const watch = setInterval(() => {
			for (const line of chromeOn(port)) seen.add(line);
		}, 500);
		try {
			expect((await run.exited).code).toBe(0);
		} finally {
			clearInterval(watch);
			killChromeOn(port);
			loaded.close();
		}
		const results = lastResults(child);
		const reason = unavailable(requestsOf(child)[0]?.tools, results[1]);
		if (reason) context.skip(`Chrome or the browser server cannot start here: ${reason}`);

		// Before the open: a real failure, not a crash, and the child goes on.
		expect(browserData(results[0]).ok).toBe(false);
		// The Chrome it drove: headless, its profile in the sandbox, never the user's.
		const opened = browserData(results[1]).data as { isolated: boolean; profileDir: string };
		expect(opened.isolated).toBe(true);
		expect(opened.profileDir.startsWith(box.root)).toBe(true);
		expect(seen.size).toBeGreaterThan(0);
		for (const line of seen) {
			expect(line).toContain("--headless");
			// An isolated HOME has no login keychain: without this a Mac's Chrome holds its first request on one.
			if (process.platform === "darwin") expect(line).toContain("--use-mock-keychain");
			expect(line).toContain(`--user-data-dir=${opened.profileDir}`);
			expect(line).not.toContain(`--user-data-dir=${os.homedir()}`);
		}
		// A plan the schema refuses names the steps it wanted.
		expect(results[2]).toContain("Validation failed");
		expect(results[2]).toContain("plan.steps.0.op");
		// The DOM, read from the rendered page: the snapshot's text artifact and the plan's extraction.
		const snapshot = browserData(results[4]);
		expect(fs.readFileSync(path.join(snapshot.root as string, "page-text.txt"), "utf8")).toContain("loopback-marker");
		const extraction = (browserData(results[5]).flow as { steps: { data: { file: string } }[] }).steps[0].data.file;
		expect(fs.readFileSync(extraction, "utf8")).toContain("loopback-marker");
		// The screenshot: the file the parent's report names is an image of a real size.
		const reported = lastResults(parent)[0] ?? "";
		const shot = /Last screenshot: (\S+?)\)/.exec(reported)?.[1] ?? "";
		const image = fs.readFileSync(path.join(box.project, shot));
		expect(image.length).toBeGreaterThan(1000);
		expect([image.subarray(0, 3).toString("hex"), image.subarray(1, 4).toString()]).toSatisfy(
			([jpeg, png]: string[]) => jpeg === "ffd8ff" || png === "PNG",
		);
		// Closed: the package says so and the process is gone.
		expect(browserData(results[7]).data?.status).toBe("CLEANED_UP");
		await until(() => chromeOn(port).length === 0, "Chrome to exit after the close", 15_000);
		// The profile's tools, its message and its report all reached the parent.
		expect(reported).toContain("browser-report");
		expect(
			requestsOf(parent)
				.at(-1)
				?.messages.map((message) => message.text)
				.join("\n"),
		).toContain("browser-note");
		await until(() => box.survivors().length === 0, "every process of the run to stop", 15_000);
	});

	it("a page cannot reach a private address the agent did not open, and a Chrome left open stops with the session", async (context) => {
		const box = repository();
		const port = await freePort();
		const connection = { port };
		let secretHits = 0;
		const secret = http.createServer((_request, response) => {
			secretHits++;
			response.writeHead(200).end("x");
		});
		const secretPort = await listen(secret);
		const requested = path.join(box.root, "page-requested");
		const pageWithSecret = http.createServer((_request, response) => {
			fs.writeFileSync(requested, "");
			response
				.writeHead(200, { "content-type": "text/html" })
				.end(`<!doctype html><title>P</title><h1>page-two</h1><img src="http://127.0.0.1:${secretPort}/secret.png">`);
		});
		const url = `http://127.0.0.1:${await listen(pageWithSecret)}/`;
		const child: Step[] = [
			call("mcp__browser__open", { url, headless: true, port }),
			call("bash", { command: waitFor(requested) }),
			call("mcp__browser__run", {
				connection,
				plan: {
					steps: [
						{ op: "goto", url },
						{ op: "extract", selector: "h1", fields: ["text"] },
					],
				},
			}),
			// No cleanup: a child that fails or forgets leaves its Chrome behind.
			{ text: "left-it-open" },
		];
		const parent: Step[] = [
			call("agent", { type: "task", profile: "browser", headless: true, goal: "open and leave", task: script(child) }),
			// Still alive after the child ended, for a follow-up.
			call("bash", { command: `ps -axww -o command= | grep -c -- '--remote-debugging-por[t]=${port}'` }),
			{ text: "parent-final" },
		];
		const run = box.start(["-p", script(parent)]);
		try {
			expect((await run.exited).code).toBe(0);
			const results = lastResults(child);
			const reason = unavailable(requestsOf(child)[0]?.tools, results[0]);
			if (reason) context.skip(`Chrome or the browser server cannot start here: ${reason}`);
			expect(secretHits, "the page's request to the other port").toBe(0);
			expect(results[2]).toContain(`127.0.0.1:${secretPort} were refused (403)`);
			expect(Number.parseInt(/\n(\d+)/.exec(lastResults(parent)[1] ?? "")?.[1] ?? "0", 10)).toBeGreaterThan(0);
			// Nothing else would ever end it: the package starts Chrome detached.
			await until(() => chromeOn(port).length === 0, "the session's shutdown to stop its Chrome", 15_000);
			const state = path.join(box.project, ".octocode/octocode-chrome-devtools/tmp/browser-state");
			expect(fs.readdirSync(state).filter((file) => file.includes(String(port)))).toEqual([]);
			await until(() => box.survivors().length === 0, "every process of the run to stop", 15_000);
		} finally {
			killChromeOn(port);
			secret.close();
			pageWithSecret.close();
		}
	});
});

describe("the real research server, declared", () => {
	it("carries each tool's full description and schema in its declaration, and its instructions in the block", async () => {
		const steps: Step[] = [{ text: "declared-done" }];
		// Declared presentation (the default) with every tool direct: the default exposure defers an unused tool.
		const run = repository({ mcpExposure: "direct" }).start(["-p", script(steps)]);
		expect((await run.exited).code).toBe(0);
		const first = requestsOf(steps)[0];
		const tools = Object.keys(first.declarations).filter((name) => name.startsWith("mcp__octocode__"));
		expect(tools).toEqual(expect.arrayContaining(["mcp__octocode__localSearch", "mcp__octocode__localFetch"]));
		for (const name of tools) {
			const { description, parameters } = first.declarations[name];
			expect(description.length, name).toBeGreaterThan(60);
			expect(JSON.stringify(parameters).length, name).toBeGreaterThan(200);
		}
		expect(JSON.stringify(first.declarations["mcp__octocode__localSearch"].parameters)).toContain("matchString");
		expect(first.system).toContain('<mcp name="octocode" tools="mcp__octocode__*">');
		expect(first.system).not.toContain("function localSearch(input:");
	});
});

describe("a configured MCP server", () => {
	const DOCS = fileURLToPath(new URL("./fixtures/docs-mcp.mjs", import.meta.url));

	it("is declared by its names, called through them, and a broken one beside it does not stop the session", async () => {
		const box = repository({});
		fs.mkdirSync(path.join(box.home, ".octocode"), { recursive: true });
		fs.writeFileSync(
			path.join(box.home, ".octocode", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					docs: { command: process.execPath, args: [DOCS] },
					broken: { command: "/no/such/binary-for-this-test", args: [] },
				},
			}),
		);
		const cases: Record<string, Record<string, unknown>> = {
			lookup: { query: "guide", limit: 2, section: "api" },
			publish: { id: "draft" },
			purge: { id: "page" },
			legacy: { source: { any: 1 }, dryRun: true },
		};
		const steps: Step[] = [
			...Object.entries(cases).map(([tool, args]) => call(`mcp__docs__${tool}`, args)),
			call("mcp__docs__lookup", { limit: 2 }),
			call("mcp", { intent: "list" }),
			call("mcp", { intent: "restart", server: "broken" }),
			{ text: "configured-done" },
		];
		const run = box.start(["-p", script(steps)]);
		expect((await run.exited).code).toBe(0);
		const first = requestsOf(steps)[0];
		const declared = first.tools
			.filter((name) => name.startsWith("mcp__docs__"))
			.map((name) => name.slice("mcp__docs__".length));
		expect([...declared].sort()).toEqual(Object.keys(cases).sort());
		expect(first.system).toContain('<mcp name="docs" tools="mcp__docs__*">');
		// Declared presentation and `recent` exposure (the defaults), on a server this folder never called: the tool's own
		// declaration carries the server's description and the field names; the full schema comes back with a refused call.
		const lookup = first.declarations["mcp__docs__lookup"];
		expect(lookup.description).toContain("Find a document by its title words.");
		expect(JSON.stringify(lookup.parameters)).toContain('"query"');
		expect(JSON.stringify(lookup.parameters)).not.toContain("Title words to search for.");
		expect(first.system).not.toContain("function lookup(input:");
		const results = lastResults(steps);
		Object.keys(cases).forEach((tool, index) => expect(results[index], tool).toContain(`${tool} ok`));
		expect(results[4]).toContain("Validation failed");
		expect(results[4]).toContain("query");
		expect(results[4]).toContain("Title words to search for.");
		expect(results[5]).toMatch(/docs: connected · 4 tools/);
		expect(results[5]).toContain("broken: failed");
		expect(results[6]).toContain('Restarting MCP server "broken" failed');
	});
});
