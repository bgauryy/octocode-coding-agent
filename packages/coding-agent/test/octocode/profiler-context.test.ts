import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProfileUpdate } from "@octocodeai/octocode-contracts/profiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProfiler, type ProfilerMember, type ProfilerSource } from "../../src/octocode/profiler/service.ts";
import { autoCompactAt } from "../../src/octocode/shared/tokens.ts";

const T0 = Date.parse("2026-11-08T10:00:00Z");
const folders: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/** A transcript as JSONL lines; every entry links to the previous one and is stamped `T0 + seconds`. */
class Transcript {
	private entries: Record<string, unknown>[] = [];
	add(entry: Record<string, unknown>, seconds = this.entries.length) {
		this.entries.push({
			id: `e${this.entries.length}`,
			parentId: this.entries.length ? `e${this.entries.length - 1}` : null,
			timestamp: new Date(T0 + seconds * 1000).toISOString(),
			...entry,
		});
		return this;
	}
	start() {
		return this.add({ type: "session", cwd: "/x" }).add({
			type: "message",
			message: {
				role: "system",
				content: "b".repeat(4000),
				sections: { environment: "e".repeat(800) },
				toolsAdded: ["read", "edit", "bash"].map((name) => ({ name, description: name.repeat(300) })),
			},
		});
	}
	user(text: string) {
		return this.add({ type: "message", message: { role: "user", content: text } });
	}
	assistant(usage: { input: number; cacheRead?: number; cacheWrite?: number; output?: number }, calls: string[] = []) {
		return this.add({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "a".repeat(400) },
					...calls.map((name) => ({ type: "toolCall", id: `call-${name}`, name })),
				],
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				durationMs: 500,
				usage: { cacheRead: 0, cacheWrite: 0, output: 10, ...usage },
			},
		});
	}
	toolResult(name: string) {
		return this.add({
			type: "message",
			message: { role: "toolResult", toolName: name, toolCallId: `call-${name}`, content: "r".repeat(600) },
		});
	}
	compaction() {
		return this.add({ type: "compaction", summary: "summary" });
	}
	write(): string {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-context-"));
		folders.push(folder);
		const file = path.join(folder, "main.jsonl");
		fs.writeFileSync(file, this.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
		return file;
	}
}

const WINDOW = 200_000;

function profilerFor(file: string, over: Partial<ProfilerMember> = {}, extra: Partial<ProfilerSource> = {}) {
	const self: ProfilerMember = {
		id: "main",
		role: "main",
		status: "working",
		joinedAt: T0 - 5000,
		updatedAt: T0 + 100_000,
		...over,
	};
	return createProfiler({
		sessionId: "s1",
		self: () => self,
		coordinatorFile: () => file,
		members: () => [],
		traffic: () => [],
		transcript: () => undefined,
		contextWindowOf: (provider, model) =>
			provider === "anthropic" && model === "claude-sonnet-4-5" ? WINDOW : undefined,
		...extra,
	});
}

const agentOf = (profiler: ReturnType<typeof profilerFor>) => profiler.agents().agents[0];

const requested = (t: Transcript) =>
	t.start().user("hello").assistant({ input: 100, cacheRead: 2000, cacheWrite: 1500, output: 40 });

describe("profiler agent context", () => {
	it("resolves the window and the compaction threshold, and leaves both absent for an unknown model", () => {
		const file = requested(new Transcript()).write();
		const known = agentOf(profilerFor(file));
		expect(known.contextWindow).toBe(WINDOW);
		expect(known.compactAt).toBe(
			autoCompactAt({ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: WINDOW }),
		);
		expect(known.compactAt).toBeLessThan(WINDOW);
		const unknown = agentOf(profilerFor(file, {}, { contextWindowOf: () => undefined }));
		expect(unknown.contextWindow).toBeUndefined();
		expect(unknown.compactAt).toBeUndefined();
		// A stored source has no resolver: the agent still lists with its context tokens.
		const stored = agentOf(profilerFor(file, {}, { contextWindowOf: undefined }));
		expect(stored.contextWindow).toBeUndefined();
		expect(stored.contextTokens).toBe(3640);
	});

	it("sums the latest request's layers by kind to its prompt, and lists the biggest layers first", () => {
		const file = requested(new Transcript()).write();
		const agent = agentOf(profilerFor(file));
		expect(agent.contextTokens).toBe(100 + 2000 + 1500 + 40);
		expect(agent.contextEstimated).toBe(true);
		expect(agent.contextLayers!.reduce((sum, layer) => sum + layer.tokens, 0)).toBe(3600);
		expect(new Set(agent.contextLayers!.map((layer) => layer.kind)).size).toBe(agent.contextLayers!.length);
		const top = agent.contextTop!;
		expect(top.length).toBeGreaterThan(0);
		expect(top.length).toBeLessThanOrEqual(5);
		expect(top.map((layer) => layer.tokens)).toEqual(top.map((layer) => layer.tokens).sort((a, b) => b - a));
		expect(top[0].label).toBeTruthy();
		expect(agent.cacheTtlMs).toBe(300_000);
	});

	it("reads the lifetime from the team row and the first entry", () => {
		const file = requested(new Transcript()).write();
		const running = profilerFor(file);
		expect(agentOf(running)).toMatchObject({ startedAt: T0 - 5000 });
		expect(agentOf(running).endedAt).toBeUndefined();
		expect(running.agents().startedAt).toBe(T0 - 5000);
		const ended = agentOf(profilerFor(file, { status: "idle", outcome: "done", updatedAt: T0 + 9000 }));
		expect(ended).toMatchObject({ endedAt: T0 + 9000 });
		expect(ended.activity).toBeUndefined();
		const unstamped = profilerFor(file, { joinedAt: undefined });
		expect(unstamped.agents().startedAt).toBe(T0);
	});

	it("leaves contextTokens absent after a compaction with no later request", () => {
		const file = requested(new Transcript()).compaction().write();
		const agent = agentOf(profilerFor(file));
		expect(agent.contextWindow).toBe(WINDOW);
		expect(agent.contextTokens).toBeUndefined();
		expect(agent.contextLayers).toBeUndefined();
		const again = requested(new Transcript()).compaction().user("more").assistant({ input: 900 }).write();
		expect(agentOf(profilerFor(again)).contextTokens).toBe(910);
	});

	describe("activity", () => {
		it("is a tool when the last reply's calls have no result, counting parallel ones", () => {
			const one = requested(new Transcript()).assistant({ input: 50 }, ["bash"]).write();
			expect(agentOf(profilerFor(one)).activity).toMatchObject({ kind: "tool", label: "bash" });
			expect(agentOf(profilerFor(one)).activity!.count).toBeUndefined();
			const t = requested(new Transcript()).assistant({ input: 50 }, ["read", "edit"]).toolResult("read");
			const two = agentOf(profilerFor(t.write())).activity!;
			expect(two).toMatchObject({ kind: "tool", label: "edit" });
			expect(two.count).toBeUndefined();
			const parallel = requested(new Transcript()).assistant({ input: 50 }, ["read", "edit"]).write();
			expect(agentOf(profilerFor(parallel)).activity).toMatchObject({ kind: "tool", label: "read", count: 2 });
		});

		it("is a wait for the user when the team row says it is blocked", () => {
			const file = requested(new Transcript()).assistant({ input: 50 }, ["bash"]).write();
			const agent = agentOf(profilerFor(file, { waiting: "approval" }));
			expect(agent.activity).toEqual({ kind: "wait", label: "permission", since: T0 + 100_000, peer: "user" });
			expect(agentOf(profilerFor(file, { waiting: "reply" })).activity).toMatchObject({ kind: "wait", label: "reply" });
		});

		it("is a wait for a peer when its message still awaits a reply", () => {
			const file = requested(new Transcript()).write();
			const traffic = [{ id: 7, from: "main", to: ["tidal-coral"], at: T0 + 4000, state: "awaiting reply", text: "q" }];
			const agent = agentOf(profilerFor(file, {}, { traffic: () => traffic as never }));
			expect(agent.activity).toEqual({
				kind: "wait",
				label: "reply from tidal-coral",
				since: T0 + 4000,
				peer: "tidal-coral",
			});
		});

		it("is a request after a user message or a tool result, stamped with that entry", () => {
			const user = new Transcript().start().user("go").write();
			expect(agentOf(profilerFor(user)).activity).toMatchObject({ kind: "request", since: T0 + 2000 });
			const result = requested(new Transcript()).assistant({ input: 50 }, ["read"]).toolResult("read").write();
			const activity = agentOf(profilerFor(result)).activity!;
			expect(activity).toMatchObject({ kind: "request", label: "claude-sonnet-4-5" });
			expect(activity.since).toBe(T0 + 5000);
		});

		it("falls back to a request since the team row's last update, and is absent when idle", () => {
			const file = requested(new Transcript()).write();
			expect(agentOf(profilerFor(file)).activity).toMatchObject({ kind: "request", since: T0 + 100_000 });
			expect(agentOf(profilerFor(file, { status: "idle" })).activity).toBeUndefined();
		});
	});

	it("sends an agent-only frame when the activity changes, and none while it holds", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0 + 200_000);
		const file = requested(new Transcript()).write();
		let member: Partial<ProfilerMember> = {};
		const profiler = profilerFor(
			file,
			{},
			{ self: () => ({ id: "main", role: "main", status: "working", ...member }) },
		);
		const frames: ProfileUpdate[] = [];
		const stop = profiler.subscribe((update) => frames.push(update));
		vi.advanceTimersByTime(1000);
		expect(frames).toEqual([]);
		member = { waiting: "approval", updatedAt: T0 + 201_000 };
		vi.advanceTimersByTime(1000);
		expect(frames).toHaveLength(1);
		expect(frames[0].request).toBeUndefined();
		expect(frames[0].agent).toMatchObject({ id: "main", activity: { kind: "wait", label: "permission" } });
		vi.advanceTimersByTime(2000);
		expect(frames).toHaveLength(1);
		member = { status: "idle" };
		vi.advanceTimersByTime(1000);
		expect(frames).toHaveLength(2);
		expect(frames[1].agent.activity).toBeUndefined();
		stop();
		profiler.close();
	});
});
