import { describe, expect, it } from "vitest";
import { agentRow, deriveRequests, prepare, type Entry } from "../../src/octocode/profiler/index.ts";

const T0 = Date.parse("2026-11-08T10:00:00Z");

/** A transcript builder: every entry links to the previous one, as the session file does. */
class Transcript {
	readonly entries: Entry[] = [];
	private clock = T0;
	add(entry: Record<string, unknown> & { type: string }, advanceMs = 1000): Entry {
		this.clock += advanceMs;
		const id = `e${this.entries.length}`;
		const full = {
			id,
			parentId: this.entries.length ? `e${this.entries.length - 1}` : null,
			timestamp: new Date(this.clock).toISOString(),
			...entry,
		} as Entry;
		this.entries.push(full);
		return full;
	}
	system(sections: Record<string, string | null>, extra: Record<string, unknown> = {}) {
		return this.add({ type: "message", message: { role: "system", content: "", sections, ...extra } });
	}
	user(text: string, origin?: string) {
		return this.add({ type: "message", ...(origin ? { origin } : {}), message: { role: "user", content: text } });
	}
	tool(name: string, text: string) {
		return this.add({ type: "message", message: { role: "toolResult", toolName: name, content: text } });
	}
	assistant(
		usage: { input?: number; cacheRead?: number; cacheWrite?: number },
		extra: Record<string, unknown> = {},
		advanceMs = 1000,
	) {
		return this.add(
			{
				type: "message",
				message: {
					role: "assistant",
					content: "a".repeat(400),
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					timestamp: this.clock + advanceMs - 500,
					durationMs: 500,
					usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, ...usage },
					...extra,
				},
			},
			advanceMs,
		);
	}
}

const tools = ["read", "edit"].map((name) => ({ name, description: name.repeat(400) }));

function start(t: Transcript, environment = "date: 2026-11-08") {
	t.add({ type: "session", id: "s", cwd: "/x" });
	t.add({
		type: "message",
		message: {
			role: "system",
			content: "b".repeat(4000),
			sections: { environment, skills: "s".repeat(2000) },
			toolsAdded: tools,
		},
	});
}

const sumBy = (layers: Array<{ state: string; tokens: number }>, state: string) =>
	layers.filter((layer) => layer.state === state).reduce((sum, layer) => sum + layer.tokens, 0);

describe("profiler derivation", () => {
	it("finds the system layer an update changed and splits states by the reported usage", () => {
		const t = new Transcript();
		start(t);
		t.user("hello");
		t.assistant({ input: 20, cacheWrite: 5000 });
		t.tool("read", "x".repeat(800));
		t.assistant({ input: 50, cacheRead: 5000, cacheWrite: 300 });
		// The environment section changes: the prefix matches only up to the tools and the base prompt.
		t.system({ environment: "date: 2026-11-09" });
		t.user("next");
		t.assistant({ input: 30, cacheRead: 1900, cacheWrite: 3500 });

		const requests = deriveRequests(t.entries, { agentId: "a" });
		expect(requests.map((r) => r.index)).toEqual([0, 1, 2]);
		const last = requests[2];
		expect(last.estimated).toBe(true);
		expect(last.layers[last.firstBreak!].label).toBe("environment");
		expect(last.layers[last.firstBreak!].changed).toBe(true);
		const first = last.layers.find((layer) => layer.label === "tools (2)")!;
		expect(first.changed).toBe(false);
		expect(requests[1].firstBreak).toBeUndefined();
		// Per-state tokens equal what the provider reported; the layers sum to the prompt.
		expect(sumBy(last.layers, "cached")).toBe(1900);
		expect(sumBy(last.layers, "written")).toBe(3500);
		expect(sumBy(last.layers, "uncached")).toBe(30);
		const order = last.layers.map((layer) => layer.state);
		expect(order.indexOf("written")).toBeGreaterThan(order.lastIndexOf("cached") - 1);
		expect(requests[0].idleMs).toBeUndefined();
		expect(requests[1].idleMs).toBeGreaterThan(0);
	});

	it("uses a recorded request trace exactly and compares hashes", () => {
		const t = new Transcript();
		start(t);
		t.user("hello");
		const trace = (systemHash: string) => ({
			requestTrace: {
				layers: [
					{ kind: "tools", chars: 4000, hash: "t1" },
					{ kind: "system", index: 0, chars: 4000, hash: "s1" },
					{ kind: "system", index: 1, chars: 400, hash: systemHash, breakpoint: true },
					{ kind: "message", role: "user", index: 0, chars: 100, hash: "m1", breakpoint: true },
				],
			},
		});
		t.assistant({ input: 100, cacheWrite: 2000 }, trace("v1"));
		t.user("again");
		t.assistant({ input: 100, cacheRead: 1000, cacheWrite: 1000 }, trace("v2"));

		const [a, b] = deriveRequests(t.entries, { agentId: "a" });
		expect(a.estimated).toBe(false);
		expect(b.estimated).toBe(false);
		expect(b.layers.map((layer) => layer.kind)).toContain("tools");
		expect(b.layers[b.firstBreak!].changed).toBe(true);
		expect(b.layers[b.firstBreak!].kind).toBe("system");
		expect(b.layers.some((layer) => layer.breakpoint)).toBe(true);
		expect(sumBy(b.layers, "cached")).toBe(1000);
		expect(b.layers.reduce((sum, layer) => sum + layer.tokens, 0)).toBe(2100);
	});

	it("reports a prompt under the minimum cacheable length as too short, not as a miss", () => {
		const t = new Transcript();
		t.add({ type: "session", id: "s", cwd: "/x" });
		t.user("hi");
		t.assistant({ input: 600 });
		const [request] = deriveRequests(t.entries, { agentId: "a" });
		expect(request.layers.every((layer) => layer.state === "too-short")).toBe(true);
		expect(request.missReason).toBeUndefined();

		const big = new Transcript();
		big.add({ type: "session", id: "s", cwd: "/x" });
		big.user("hi");
		big.assistant({ input: 600, cacheWrite: 100 });
		expect(deriveRequests(big.entries, { agentId: "a" })[0].layers.some((l) => l.state === "too-short")).toBe(false);
	});

	it("explains a miss after an idle gap with the cache accounting's own wording", () => {
		const t = new Transcript();
		start(t);
		t.user("hello");
		t.assistant({ input: 20, cacheWrite: 6000 });
		t.user("later");
		t.assistant({ input: 40, cacheWrite: 6100 }, {}, 2 * 3_600_000);
		const [, second] = deriveRequests(t.entries, { agentId: "a" });
		expect(second.missReason).toMatch(/idle/);
		expect(second.idleMs).toBeGreaterThan(3_600_000);
	});

	it("shows notices, steers, interrupts, tool results and compaction summaries as layers", () => {
		const t = new Transcript();
		start(t);
		t.user("go");
		t.assistant({ input: 20, cacheWrite: 3000 });
		t.tool("read", "result");
		t.add({ type: "custom_message", customType: "octocode-memory", content: "note", display: false });
		t.add({ type: "custom", customType: "octocode-interrupt", data: { reason: "user_abort", at: T0 } });
		t.user("change course", "steer");
		t.assistant({ input: 200, cacheRead: 3000 });
		const [, request] = deriveRequests(t.entries, { agentId: "a", detail: true });
		const labels = request.layers.map((layer) => `${layer.kind}:${layer.label}`);
		expect(labels).toEqual(
			expect.arrayContaining([
				"tool-result:read",
				"notice:octocode-memory",
				"interrupt:interrupt: user_abort",
				"steer:steer",
			]),
		);
		// The marker costs no tokens; no layer carries message text.
		expect(request.layers.find((layer) => layer.kind === "interrupt")!.tokens).toBe(0);
		expect(JSON.stringify(request)).not.toContain("change course");

		t.add({ type: "compaction", summary: "s".repeat(200), firstKeptEntryId: "e6" });
		t.user("after");
		t.assistant({ input: 100, cacheWrite: 2000 });
		const after = deriveRequests(t.entries, { agentId: "a", detail: true }).at(-1)!;
		expect(after.layers.some((layer) => layer.kind === "summary")).toBe(true);
		// A layer that crosses a cache boundary is split, so count the entries the assistant layers came from.
		expect(new Set(after.layers.filter((layer) => layer.label === "assistant").map((layer) => layer.entry)).size).toBe(
			1,
		);
	});

	it("groups a long unchanged history unless detail is asked for", () => {
		const t = new Transcript();
		start(t);
		for (let i = 0; i < 10; i++) {
			t.user(`q${i}`);
			t.assistant({ input: 10, cacheRead: 100 + i, cacheWrite: 10 });
		}
		const last = deriveRequests(t.entries, { agentId: "a", after: 8 })[0];
		const grouped = last.layers.find((layer) => layer.label.startsWith("history ("));
		expect(grouped).toBeDefined();
		const full = deriveRequests(t.entries, { agentId: "a", after: 8, detail: true })[0];
		expect(full.layers.length).toBeGreaterThan(last.layers.length);
		expect(full.layers.reduce((s, l) => s + l.tokens, 0)).toBe(last.layers.reduce((s, l) => s + l.tokens, 0));
	});

	it("summarizes an agent and lists one without a transcript as unprofiled", () => {
		const t = new Transcript();
		start(t);
		t.user("go");
		t.assistant({ input: 100, cacheRead: 300, cacheWrite: 100 });
		const row = agentRow({ id: "main", role: "main", status: "idle" }, prepare(t.entries));
		expect(row).toMatchObject({ requests: 1, profiled: true, hitRate: 0.6, model: "claude-sonnet-4-5" });
		expect(agentRow({ id: "ext", role: "external", status: "working" })).toMatchObject({
			profiled: false,
			requests: 0,
		});
	});
});
