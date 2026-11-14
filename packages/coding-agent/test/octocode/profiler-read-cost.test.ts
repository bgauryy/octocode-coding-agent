import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createProfiler, type ProfilerMember } from "../../src/octocode/profiler/service.ts";

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-cost-"));
	roots.push(root);
	const file = path.join(root, "main.jsonl");
	fs.writeFileSync(
		file,
		`${JSON.stringify({ id: "a", type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", model: "test", provider: "test", content: "answer", usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 } } })}\n`,
	);
	const self: ProfilerMember = { id: "main", role: "main", status: "idle" };
	const children = Array.from({ length: 12 }, (_, index): ProfilerMember => ({
		id: `child-${index}`,
		role: "researcher",
		status: "idle",
	}));
	const traffic = vi.fn(() => []);
	const transcript = vi.fn(() => file);
	const profiler = createProfiler({
		sessionId: "s",
		self: () => self,
		coordinatorFile: () => file,
		members: () => children,
		traffic,
		transcript,
	});
	return { profiler, self, traffic, transcript };
}

it("loads only the selected agent's transcript and does not read traffic for a request page", () => {
	const { profiler, traffic, transcript } = fixture();
	try {
		expect(profiler.requests("child-7")?.requests).toHaveLength(1);
		expect(transcript.mock.calls).toEqual([["child-7"]]);
		expect(traffic).not.toHaveBeenCalled();
		expect(profiler.requests("unknown")).toBeUndefined();
		expect(transcript).toHaveBeenCalledTimes(1);
	} finally {
		profiler.close();
	}
});

it("uses one traffic snapshot for all agents, including each live poll", () => {
	vi.useFakeTimers();
	const { profiler, traffic } = fixture();
	try {
		expect(profiler.agents().agents).toHaveLength(13);
		expect(traffic).toHaveBeenCalledTimes(1);
		const stop = profiler.subscribe(() => {});
		expect(traffic).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(1000);
		expect(traffic).toHaveBeenCalledTimes(3);
		stop();
		vi.advanceTimersByTime(1000);
		expect(traffic).toHaveBeenCalledTimes(3);
	} finally {
		profiler.close();
	}
});

it("publishes an idle agent's final outcome without needing another request", () => {
	vi.useFakeTimers();
	const { profiler, self } = fixture();
	const listener = vi.fn();
	try {
		profiler.subscribe(listener);
		self.outcome = "done";
		self.updatedAt = Date.now();
		vi.advanceTimersByTime(1000);
		expect(listener).toHaveBeenCalledWith(
			expect.objectContaining({ agent: expect.objectContaining({ id: "main", outcome: "done" }) }),
		);
	} finally {
		profiler.close();
	}
});
