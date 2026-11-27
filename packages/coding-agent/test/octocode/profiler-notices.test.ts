import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProfiler } from "../../src/octocode/profiler/index.ts";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";

const T = Date.UTC(2026, 10, 8, 10, 0, 0);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const at = (ms: number) => new Date(T + ms).toISOString();
const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function transcript(name: string, entries: unknown[]): string {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-notices-"));
	folders.push(folder);
	const file = path.join(folder, `${name}.jsonl`);
	fs.writeFileSync(file, entries.map(line).join(""));
	return file;
}

const assistant = (id: string, ms: number) => ({
	type: "message",
	id,
	timestamp: at(ms),
	message: {
		role: "assistant",
		content: [{ type: "thinking", thinking: "plan" }],
		usage: {},
		model: "m",
		stopReason: "stop",
	},
});

const mainMember: Member = {
	id: "main",
	role: "main",
	pid: 1,
	status: "idle",
	joinedAt: 1,
	updatedAt: 1,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	tmuxPane: "%3",
};

describe("profiler messages: internal notices and endpoints", () => {
	const sent: Traffic = { id: 5, from: "child", to: ["main"], text: "done", at: T + 1500, state: "delivered" };

	it("lists check-ins and API mail as internal messages, links the sender's transcript, and skips mail the database holds", () => {
		const main = transcript("main", [
			{ type: "session", id: "s-main", timestamp: at(0) },
			{
				type: "custom_message",
				id: "c1",
				timestamp: at(2000),
				customType: "octocode-agent-message",
				content: "check in",
				details: {
					messages: [
						{ from: "team", text: "child went quiet", at: T + 2000 },
						{ id: 5, from: "child", to: "main", text: "done", at: T + 1500 },
					],
				},
			},
			{
				type: "custom_message",
				id: "c2",
				timestamp: at(3000),
				customType: "octocode-external-message",
				content: "fenced",
				details: { from: "cli", at: T + 3000, message: { text: "ping from cli" } },
			},
		]);
		const kid = transcript("child", [
			{ type: "session", id: "s-child", timestamp: at(0) },
			assistant("a1", 1000),
			assistant("a2", 1400),
			assistant("a3", 1800),
		]);
		const profiler = createProfiler({
			sessionId: "s-main",
			self: () => ({ id: "main", role: "main", status: "idle" }),
			coordinatorFile: () => main,
			members: () => [{ id: "child", role: "implementer", status: "idle", parentId: "main" }],
			traffic: () => [sent],
			transcript: (id) => (id === "child" ? kid : undefined),
			endpoints: () => ({
				members: [mainMember],
				departed: (id) => (id === "child" ? { role: "implementer", sessionId: "s-child" } : undefined),
			}),
		});

		const { messages, events } = profiler.timeline();
		const real = messages.find((message) => message.id === 5)!;
		expect(real.internal).toBeUndefined();
		expect(real.fromEndpoint).toMatchObject({ id: "child", role: "implementer", departed: true });
		expect(real.toEndpoints?.[0]).toMatchObject({ id: "main", tmuxPane: "%3" });
		// The sender's last reply written at or before the send, by line index (the header is line 0).
		expect(real.transcript).toEqual({ agentId: "child", sessionId: "s-child", entry: 2 });
		const internal = messages.filter((message) => message.internal);
		expect(internal.map((message) => [message.from, message.text, message.label])).toEqual([
			["team", "child went quiet", "octocode-agent-message"],
			["cli", "ping from cli", "octocode-external-message"],
		]);
		expect(internal.every((message) => message.id < 0)).toBe(true);
		expect(new Set(internal.map((message) => message.id)).size).toBe(2);
		expect(internal[0]).toMatchObject({
			to: ["main"],
			transcript: { agentId: "main", sessionId: "s-main", entry: 1 },
			fromEndpoint: { id: "team", role: "team" },
		});
		expect(internal[1]?.fromEndpoint).toEqual({ id: "cli", role: "external" });
		// Notices stay out of the message lanes: the lane already shows them as notice events.
		expect(events.filter((event) => event.kind === "message").map((event) => event.ref?.message)).toEqual([5, 5]);
		expect(events.filter((event) => event.kind === "notice")).toHaveLength(2);
	});

	it("without an endpoint resolver messages carry no endpoints", () => {
		const main = transcript("main", [{ type: "session", id: "s-main", timestamp: at(0) }]);
		const profiler = createProfiler({
			sessionId: "s-main",
			self: () => ({ id: "main", role: "main", status: "idle" }),
			coordinatorFile: () => main,
			members: () => [],
			traffic: () => [sent],
			transcript: () => undefined,
		});
		const [message] = profiler.timeline().messages;
		expect(message?.fromEndpoint).toBeUndefined();
		expect(message?.toEndpoints).toBeUndefined();
	});
});
