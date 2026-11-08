import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProfiler } from "../../src/octocode/profiler/index.ts";
import { PERMISSION_WAIT_MS } from "../../src/octocode/profiler/insights.ts";
import { toTraffic } from "../../src/octocode/team/model.ts";

const T = Date.UTC(2026, 10, 8, 10, 0, 0);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/** A coordinator transcript with permission audit entries: `asked` and `decided` are ms after T (decided is the entry's `at`). */
function profilerFor(asks: Array<{ asked?: number; decided: number }>, traffic = [] as never[]) {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-wait-"));
	folders.push(folder);
	const file = path.join(folder, "main.jsonl");
	fs.writeFileSync(
		file,
		line({ type: "session", id: "s" }) +
			asks
				.map((ask, i) =>
					line({
						type: "custom",
						id: `p${i}`,
						timestamp: new Date(T + ask.decided).toISOString(),
						customType: "octocode-permission",
						data: {
							at: T + ask.decided,
							...(ask.asked === undefined ? {} : { askedAt: T + ask.asked }),
							action: "shell.run",
						},
					}),
				)
				.join(""),
	);
	return createProfiler({
		sessionId: "s1",
		self: () => ({ id: "main", role: "main", status: "working" }),
		coordinatorFile: () => file,
		members: () => [],
		traffic: () => traffic,
		transcript: () => undefined,
	});
}

describe("profiler permission waits", () => {
	it("emits a permission wait span from the ask to the decision, and a finding past the threshold", () => {
		const profiler = profilerFor([
			{ asked: 1000, decided: 1000 + PERMISSION_WAIT_MS + 5000 },
			{ asked: 100_000, decided: 102_000 },
			{ decided: 200_000 },
		]);
		const waits = profiler.timeline().events.filter((event) => event.kind === "wait");
		expect(waits).toMatchObject([
			{ agentId: "main", label: "permission", at: T + 1000, durationMs: PERMISSION_WAIT_MS + 5000 },
			{ label: "permission", at: T + 100_000, durationMs: 2000 },
		]);
		expect(profiler.timeline().events.filter((event) => event.kind === "permission")).toHaveLength(3);
		const found = profiler.insights().findings.filter((finding) => finding.kind === "permission-wait");
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ agentId: "main", waitedMs: PERMISSION_WAIT_MS + 5000, severity: "medium" });
		expect(found[0].evidence).toEqual([{ agentId: "main", event: waits[0].id }]);
	});

	it("reports no finding when every ask was answered quickly", () => {
		const profiler = profilerFor([{ asked: 0, decided: PERMISSION_WAIT_MS - 1 }]);
		expect(profiler.insights().findings.map((finding) => finding.kind)).not.toContain("permission-wait");
	});
});

describe("profiler message delivery time", () => {
	it("sets deliveredMs from the first delivery of a message", () => {
		const row = { id: 7, sender: "main", body: "hi", created_at: T, reply_required: 0 };
		const traffic = [
			toTraffic(row, [
				{ recipient: "a", delivered_at: T + 900, completed_at: null, dead_at: null },
				{ recipient: "b", delivered_at: T + 400, completed_at: null, dead_at: null },
			]),
			toTraffic({ ...row, id: 8 }, [{ recipient: "a", delivered_at: null, completed_at: null, dead_at: null }]),
		];
		expect(traffic[0].deliveredAt).toBe(T + 400);
		expect(traffic[1].deliveredAt).toBeUndefined();
		const timeline = profilerFor([], traffic as never[]).timeline();
		expect(timeline.messages.find((m) => m.id === 7)).toMatchObject({ deliveredMs: 400, text: "hi", preview: "hi" });
		expect(timeline.messages.find((m) => m.id === 8)).not.toHaveProperty("deliveredMs");
	});
});

describe("profiler reads the recorded entry shapes", () => {
	it("takes origin from the entry, interrupts from custom entries and a trace from an error message", () => {
		const folder = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-shape-"));
		folders.push(folder);
		const file = path.join(folder, "main.jsonl");
		const at = (ms: number) => new Date(T + ms).toISOString();
		const trace = { cacheMode: "5m", layers: [{ kind: "system", index: 0, chars: 400, hash: "s" }] };
		fs.writeFileSync(
			file,
			line({ type: "session", id: "s" }) +
				line({
					type: "message",
					id: "u1",
					timestamp: at(1000),
					origin: "steer",
					message: { role: "user", content: "x" },
				}) +
				line({
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: at(2000),
					message: {
						role: "assistant",
						content: "",
						model: "m",
						stopReason: "error",
						requestTrace: trace,
						usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 0 },
					},
				}) +
				line({
					type: "custom",
					id: "i1",
					timestamp: at(3000),
					customType: "octocode-interrupt",
					data: { reason: "user", at: T + 3000 },
				}),
		);
		const profiler = createProfiler({
			sessionId: "s1",
			self: () => ({ id: "main", role: "main", status: "working" }),
			coordinatorFile: () => file,
			members: () => [],
			traffic: () => [],
			transcript: () => undefined,
		});
		const events = profiler.timeline().events;
		expect(events.find((e) => e.kind === "steer")).toMatchObject({ label: "steer" });
		expect(events.find((e) => e.kind === "interrupt")).toMatchObject({ label: "interrupt: user", at: T + 3000 });
		expect(events.find((e) => e.kind === "request")).toMatchObject({ outcome: "error" });
		const [request] = profiler.requests("main", undefined, true)!.requests;
		expect(request.estimated).toBe(false);
		expect(request.layers.some((layer) => layer.kind === "system")).toBe(true);
	});
});
