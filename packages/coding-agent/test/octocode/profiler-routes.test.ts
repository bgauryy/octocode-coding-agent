import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type {
	ProfileAgents,
	ProfileInsights,
	ProfileRequests,
	ProfileTimeline,
} from "@octocodeai/octocode-contracts/profiler";
import { WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { openAgentDb } from "../../src/storage/database.ts";
import { createProfiler } from "../../src/octocode/profiler/index.ts";
import type { RevisedWorkspace } from "../../src/octocode/workspace/revision.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

const T = Date.UTC(2026, 10, 8, 10, 0, 0);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (n: number, usage: Record<string, number>) =>
	line({
		type: "message",
		id: `a${n}`,
		parentId: n ? `u${n}` : "s",
		timestamp: new Date(Date.UTC(2026, 10, 8, 10, 0, n)).toISOString(),
		message: {
			role: "assistant",
			content: "secret reply text",
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			usage,
		},
	});
const user = (n: number) =>
	line({
		type: "message",
		id: `u${n}`,
		parentId: n ? `a${n - 1}` : "s",
		message: { role: "user", content: "secret prompt text" },
	});

async function board(files: { main: string; child?: string }) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-route-"));
	const main = path.join(directory, "main.jsonl");
	fs.writeFileSync(main, files.main);
	const child = path.join(directory, "child.jsonl");
	if (files.child) fs.writeFileSync(child, files.child);
	const profiler = createProfiler({
		sessionId: "s1",
		self: () => ({ id: "main-agent", role: "main", status: "working" }),
		coordinatorFile: () => main,
		members: () => [
			{ id: "kid", role: "general", status: "idle", parentId: "main-agent", joinedAt: T - 1000 },
			{ id: "ext", role: "external", status: "idle", parentId: "main-agent" },
		],
		traffic: () => [
			{ id: 1, from: "main-agent", to: ["kid"], text: "do the thing\nsecond line", at: T, state: "answered" },
			{ id: 2, from: "kid", to: ["main-agent"], text: "done", at: T + 5000, replyTo: 1, state: "delivered" },
			{ id: 3, from: "main-agent", to: ["kid"], text: "lost", at: T + 9000, state: "dead-lettered" },
		],
		transcript: (id) => (id === "kid" && files.child ? child : undefined),
	});
	const workspace: RevisedWorkspace = {
		profiler,
		snapshot: () => ({ sessionId: "s1", agents: [], traffic: [], events: [], receipts: [] }),
		execute: async () => {
			throw new Error("not used");
		},
		subscribe: () => () => undefined,
		close: () => profiler.close(),
	};
	const db = openAgentDb(path.join(directory, "db"));
	const web = await startWorkspaceWeb(
		{
			store: fixtureBacklog(() => db, "repo"),
			actor: { id: "s1" },
			session: "s1",
			repoName: "repo",
			repoRoot: directory,
		},
		undefined,
		workspace,
	);
	cleanup.push(() => {
		db.close();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	cleanup.push(() => web.close());
	return { url: new URL(web.url), main, child };
}

const get = (url: URL, route: string, token = url.hash.slice("#access=".length)) =>
	fetch(new URL(route, url.origin), { headers: token ? { authorization: `Bearer ${token}` } : {} });

const cached = { input: 20, output: 5, cacheRead: 0, cacheWrite: 3000 };

describe("profiler routes on the workspace server", () => {
	it("serves agents and paged requests with the server's token check, and never message text", async () => {
		const main = user(0) + assistant(0, cached) + user(1) + assistant(1, { ...cached, cacheRead: 3000, cacheWrite: 0 });
		const { url } = await board({
			main: `${line({ type: "session", id: "s" })}${main}`,
			child: line({ type: "session", id: "c" }),
		});

		expect((await get(url, WORKSPACE_ROUTES.profiler, "")).status).toBe(401);
		expect((await get(url, `${WORKSPACE_ROUTES.profiler}/agents/main-agent`, "wrong")).status).toBe(401);

		const agents = (await (await get(url, WORKSPACE_ROUTES.profiler)).json()) as ProfileAgents;
		expect(agents.sessionId).toBe("s1");
		expect(agents.agents.map((a) => [a.id, a.profiled, a.requests])).toEqual([
			["main-agent", true, 2],
			["kid", true, 0],
			["ext", false, 0],
		]);

		const page = await get(url, `${WORKSPACE_ROUTES.profiler}/agents/main-agent?after=0`);
		const body = (await page.json()) as ProfileRequests;
		expect(body.requests.map((r) => r.index)).toEqual([1]);
		expect(body.hasMore).toBe(false);
		expect(JSON.stringify(body)).not.toContain("secret");

		expect((await get(url, `${WORKSPACE_ROUTES.profiler}/agents/nobody`)).status).toBe(404);
		expect((await get(url, `${WORKSPACE_ROUTES.profiler}/agents/main-agent?after=-1`)).status).toBe(400);
		const post = await fetch(new URL(WORKSPACE_ROUTES.profiler, url.origin), {
			method: "POST",
			headers: { authorization: `Bearer ${url.hash.slice(8)}`, "content-type": "application/json" },
			body: "{}",
		});
		expect(post.status).toBe(405);
	});

	it("serves the timeline with messages on both lanes, insights and a Chrome trace", async () => {
		const tool = line({
			type: "message",
			id: "t0",
			parentId: "a0",
			timestamp: new Date(T + 4000).toISOString(),
			message: { role: "toolResult", toolName: "bash", isError: true, durationMs: 3000, content: "secret" },
		});
		const main = `${line({ type: "session", id: "s" })}${user(0)}${assistant(0, cached)}${tool}`;
		const { url } = await board({ main });
		const timeline = (await (await get(url, `${WORKSPACE_ROUTES.profiler}/timeline`)).json()) as ProfileTimeline;
		const kinds = timeline.events.map((e) => `${e.agentId}:${e.kind}:${e.direction ?? ""}`);
		expect(kinds).toEqual(
			expect.arrayContaining([
				"main-agent:message:sent",
				"kid:message:received",
				"kid:message:sent",
				"main-agent:message:received",
				"main-agent:wait:",
				"kid:spawn:",
				"main-agent:request:",
				"main-agent:tool:",
			]),
		);
		expect(timeline.events.find((e) => e.kind === "wait")!.durationMs).toBe(5000);
		expect(timeline.messages[0]).toMatchObject({ id: 1, preview: "do the thing", answeredMs: 5000 });
		expect(JSON.stringify(timeline)).not.toContain("secret");
		const later = (await (
			await get(url, `${WORKSPACE_ROUTES.profiler}/timeline?since=${T + 8000}`)
		).json()) as ProfileTimeline;
		expect(later.messages.map((m) => m.id)).toEqual([3]);
		expect((await get(url, `${WORKSPACE_ROUTES.profiler}/timeline?since=x`)).status).toBe(400);

		const insights = (await (await get(url, `${WORKSPACE_ROUTES.profiler}/insights`)).json()) as ProfileInsights;
		expect(insights.findings.map((f) => f.kind)).toContain("dead-letter");

		const trace = await get(url, `${WORKSPACE_ROUTES.profiler}/trace`);
		expect(trace.headers.get("content-disposition")).toMatch(/attachment/);
		const body = (await trace.json()) as { traceEvents: Array<{ ph: string; name: string }> };
		expect(body.traceEvents.filter((e) => e.ph === "M").map((e) => e.name)).toEqual([
			"process_name",
			"process_name",
			"process_name",
		]);
		expect(body.traceEvents.some((e) => e.ph === "X")).toBe(true);
		expect(body.traceEvents.filter((e) => e.ph === "s")).toHaveLength(
			body.traceEvents.filter((e) => e.ph === "f").length,
		);
	});

	it("bounds a page and says more follows", async () => {
		let main = line({ type: "session", id: "s" });
		for (let i = 0; i < 60; i++) main += user(i) + assistant(i, { input: 10, cacheRead: 2000, cacheWrite: 0 });
		const { url } = await board({ main });
		const body = (await (await get(url, `${WORKSPACE_ROUTES.profiler}/agents/main-agent`)).json()) as ProfileRequests;
		expect(body.requests).toHaveLength(50);
		expect(body.hasMore).toBe(true);
		const next = (await (
			await get(url, `${WORKSPACE_ROUTES.profiler}/agents/main-agent?after=49`)
		).json()) as ProfileRequests;
		expect(next.requests.map((r) => r.index)).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
		expect(next.hasMore).toBe(false);
	});

	it("pushes a profiler frame to an authenticated socket when a listed agent appends a request", async () => {
		const start = `${line({ type: "session", id: "s" })}${user(0)}${assistant(0, cached)}`;
		const { url, child } = await board({ main: start, child: line({ type: "session", id: "c" }) });
		const frames: Array<{ type: string; data: { agent: { id: string }; request: { index: number } } }> = [];
		const socket = new WebSocket(`ws://${url.host}${WORKSPACE_ROUTES.live}`, { origin: url.origin });
		cleanup.push(() => socket.terminate());
		socket.on("message", (data) => frames.push(JSON.parse(String(data))));
		await new Promise((resolve) => socket.once("open", resolve));
		socket.send(url.hash.slice("#access=".length));
		await new Promise((resolve) => setTimeout(resolve, 300));
		// The requests that existed when the page connected are its baseline, not frames.
		expect(frames.some((frame) => frame.type === "profiler")).toBe(false);
		fs.appendFileSync(child, user(0) + assistant(0, cached));
		const deadline = Date.now() + 5000;
		while (!frames.some((frame) => frame.type === "profiler") && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 100));
		const frame = frames.find((each) => each.type === "profiler");
		expect(frame?.data.agent.id).toBe("kid");
		expect(frame?.data.request.index).toBe(0);
	});
});
