import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import { AGENT_RESULT_TYPE } from "../../src/octocode/shared/messages.ts";
import type { Report } from "../../src/octocode/subagents/handoff/pending.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const entry = (id: string, customType: string, details: unknown = {}): SessionEntry => ({
	type: "custom_message",
	id,
	parentId: null,
	timestamp: new Date().toISOString(),
	customType,
	content: "",
	display: false,
	details,
});

describe("incremental report receipts", () => {
	it("checks only new entries across ticks in a 10,000-entry in-memory session", () => {
		let visits = 0;
		const entries = Array.from({ length: 10_000 }, (_, index) => ({
			...entry(`e${index}`, "unrelated"),
			get customType() {
				visits++;
				return "unrelated";
			},
		}));
		const queue = new ReportQueue(fakeHost().api, 60_000);
		const getEntries = vi.fn(() => entries);
		queue.start({ getSessionFile: () => undefined, getEntries, getEntryCount: () => entries.length });
		queue.pendingDir = tmp();
		const report: Report = {
			reportId: "r1",
			content: "report",
			details: { id: "child", status: "done", summary: "Done" },
			wake: true,
		};
		try {
			queue.add(report);
			const initial = visits;
			for (let index = 0; index < 20; index++) queue.recorded();
			expect(visits).toBe(initial);
			expect(getEntries).toHaveBeenCalledTimes(1);
			entries.push(entry("receipt", AGENT_RESULT_TYPE, { reportId: "r1" }) as (typeof entries)[number]);
			queue.recorded();
			expect(visits).toBe(initial);
			expect(getEntries).toHaveBeenCalledTimes(2);
			expect(fs.readdirSync(queue.pendingDir)).toEqual([]);
			// Replacing the tail invalidates the high-water mark.
			entries.splice(
				0,
				entries.length,
				entry("replacement", AGENT_RESULT_TYPE, { reportId: "r2" }) as (typeof entries)[number],
			);
			queue.add({ ...report, reportId: "r2" });
			queue.recorded();
			expect(fs.readdirSync(queue.pendingDir)).toEqual([]);
		} finally {
			queue.persist();
		}
	});

	it("settles a rejected send with a memory receipt before the transcript flushes", async () => {
		vi.useFakeTimers();
		const fake = fakeHost();
		const send = vi.fn(() => Promise.reject(new Error("response lost")));
		fake.api.sendMessage = send;
		const entries: SessionEntry[] = [];
		const file = path.join(tmp(), "session.jsonl");
		fs.writeFileSync(file, "");
		const queue = new ReportQueue(fake.api, 60_000);
		queue.start({ getSessionFile: () => file, getEntries: () => entries });
		queue.pendingDir = tmp();
		try {
			queue.add({
				reportId: "r1",
				content: "report",
				details: { id: "child", status: "done", summary: "Done" },
				wake: true,
			});
			queue.flush();
			entries.push(entry("receipt", AGENT_RESULT_TYPE, { reportId: "r1" }));
			await vi.advanceTimersByTimeAsync(5_000);
			expect(send).toHaveBeenCalledTimes(1);
			expect(fs.readdirSync(queue.pendingDir)).toEqual([]);
		} finally {
			queue.persist();
			vi.useRealTimers();
		}
	});
});
