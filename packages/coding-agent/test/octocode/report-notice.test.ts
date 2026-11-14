import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { noticeText, NOTICE_TYPE, ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import { AGENT_RESULT_TYPE } from "../../src/octocode/shared/messages.ts";
import { createHarness, getMessageText } from "../suite/harness.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import type { Report } from "../../src/octocode/subagents/handoff/pending.ts";

const report = (id: string, extra: Partial<Report> = {}): Report => ({
	content: `Background subagent ${id} reported done`,
	details: { id, status: "done", outcome: "done", summary: "Done" },
	wake: true,
	...extra,
});

/** Follow ordinary strong fields only: weak maps and callback closures cannot own this newly created report. */
function retains(root: unknown, target: object, seen = new Set<object>()): boolean {
	if (root === target) return true;
	if (!root || typeof root !== "object" || seen.has(root)) return false;
	seen.add(root);
	const values =
		root instanceof Map ? [...root.keys(), ...root.values()] : root instanceof Set ? [...root] : Object.values(root);
	return values.some((value) => retains(value, target, seen));
}

describe("the mid-turn notice of a background report (B11)", () => {
	it.each(["recorded", "persisted"] as const)("releases deferred notice payloads once a report is %s", (ending) => {
		const entries: unknown[] = [];
		const f = fakeHost();
		const queue = new ReportQueue(f.api);
		queue.start({ getSessionFile: () => undefined, getEntries: () => entries as never }, () => false);
		const finished = report("large", { reportId: "large-report", content: "x".repeat(64 * 1024) });
		try {
			queue.add(finished);
			queue.flush();
			expect(retains(queue, finished)).toBe(true);
			if (ending === "recorded") {
				entries.push({ type: "custom_message", customType: AGENT_RESULT_TYPE, details: { reportId: "large-report" } });
				queue.recorded();
			} else queue.persist();
			expect(retains(queue, finished)).toBe(false);
			queue.start({ getSessionFile: () => undefined, getEntries: () => [] }, () => false);
			queue.stepEnded();
			expect(f.sent.filter(({ message }) => message.customType === NOTICE_TYPE)).toHaveLength(0);
		} finally {
			queue.persist();
		}
	});

	it("delivers one current notice after persistence/recovery of the same report id", () => {
		const f = fakeHost();
		const queue = new ReportQueue(f.api);
		const session = { getSessionFile: () => undefined, getEntries: () => [] };
		queue.start(session, () => false);
		try {
			queue.add(report("child", { reportId: "same-report" }));
			queue.flush();
			queue.persist();
			queue.start(session, () => false);
			queue.add(
				report("child", {
					reportId: "same-report",
					details: { id: "child", status: "done", outcome: "blocked", summary: "needs input" },
				}),
			);
			queue.flush();
			queue.stepEnded();
			queue.stepEnded();
			const notices = f.sent.filter(({ message }) => message.customType === NOTICE_TYPE);
			expect(notices).toHaveLength(1);
			expect(notices[0].message.content).toContain("child blocked");
		} finally {
			queue.persist();
		}
	});

	it("is a short steering message with the agent, outcome and report path, and never the child's words", () => {
		const text = noticeText(
			report("w1", {
				content:
					"Background subagent w1 reported done\n\nFull report: .octocode/code/temp/agents/w1/report.md (read only the parts you need).",
				details: {
					...report("w1").details,
					reportArtifact: { sha256: "a".repeat(64), path: ".octocode/code/temp/agents/w1/report.md" },
				},
			}),
		);
		expect(text).toContain("w1 done");
		expect(text).toContain(".octocode/code/temp/agents/w1/report.md");
		expect(text).toContain("when this turn ends");
		// A pointer the child wrote itself, anywhere but a scratch folder, is not repeated.
		const forged = noticeText(report("w2", { content: "Full report: /etc/passwd (read only the parts you need)." }));
		expect(forged).not.toContain("/etc/passwd");
	});

	it("is sent once at the parent's next step, without waking it; the report still follows as a follow-up", () => {
		const f = fakeHost();
		let idle = false;
		const queue = new ReportQueue(f.api);
		queue.start({ getSessionFile: () => undefined, getEntries: () => [] }, () => idle);
		queue.add(report("a"));
		queue.flush();
		queue.add({ ...report("quiet"), wake: false });
		queue.flush();
		expect(f.sent.filter(({ message }) => message.customType === NOTICE_TYPE)).toHaveLength(0);
		queue.stepEnded();
		queue.stepEnded();
		const notices = f.sent.filter(({ message }) => message.customType === NOTICE_TYPE);
		expect(notices).toHaveLength(1);
		expect(notices[0].options).toEqual({ triggerTurn: false, deliverAs: "steer" });
		expect(notices[0].message.display).toBe(false);
		const reports = f.sent.filter(({ message }) => message.customType === AGENT_RESULT_TYPE);
		expect(reports.map(({ options }) => options.deliverAs)).toEqual(["followUp", "followUp"]);
		queue.persist();
		idle = true;
	});

	it("spends no request when the report arrives during the parent's last reply", async () => {
		let host!: ExtensionAPI;
		const root = tmp();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(api) => {
					host = api;
					api.on("turn_end", async (event) => {
						if (event.toolResults.length > 0) queue.stepEnded();
						return undefined;
					});
				},
			],
		});
		await harness.session.bindExtensions({});
		const queue = new ReportQueue(host);
		queue.start(manager, () => !harness.session.isStreaming);
		const requests: string[][] = [];
		harness.setResponses([
			(context) => {
				requests.push(context.messages.map((message) => getMessageText(message)));
				// The child finishes while the parent's reply streams.
				queue.add(report("worker"));
				queue.flush();
				return fauxAssistantMessage("my last reply");
			},
			(context) => {
				requests.push(context.messages.map((message) => getMessageText(message)));
				return fauxAssistantMessage("report read");
			},
		]);
		try {
			await harness.session.prompt("go");
			await harness.session.agent.waitForIdle();
			expect(requests).toHaveLength(2);
			expect(requests[1].some((text) => text.includes("Background subagent worker reported done"))).toBe(true);
			expect(requests.flat().some((text) => text.includes("[Octocode notice]"))).toBe(false);
		} finally {
			queue.persist();
			harness.cleanup();
		}
	});

	it("stays silent for an idle parent: the report itself wakes it", () => {
		const f = fakeHost();
		const queue = new ReportQueue(f.api);
		queue.start({ getSessionFile: () => undefined, getEntries: () => [] }, () => true);
		queue.add(report("a"));
		queue.flush();
		expect(f.sent.map(({ message }) => message.customType)).toEqual([AGENT_RESULT_TYPE]);
		queue.persist();
	});

	it("reaches the model at its next step of a running turn, before the turn ends", async () => {
		let host!: ExtensionAPI;
		const root = tmp();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const finishInTurn: AgentTool = {
			name: "finish",
			label: "Finish",
			description: "A subagent finishes while this tool runs",
			parameters: Type.Object({}),
			execute: async () => {
				queue.add(report("worker"));
				queue.flush();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};
		const harness = await createHarness({
			sessionManager: manager,
			tools: [finishInTurn],
			extensionFactories: [
				(api) => {
					host = api;
					api.on("turn_end", async (event) => {
						if (event.toolResults.length > 0) queue.stepEnded();
						return undefined;
					});
				},
			],
		});
		await harness.session.bindExtensions({});
		const queue = new ReportQueue(host);
		queue.start(manager, () => !harness.session.isStreaming);
		queue.pendingDir = path.join(root, "reports");
		let secondRequest: string[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("finish", {})], { stopReason: "toolUse" }),
			(context) => {
				secondRequest = context.messages.map((message) => getMessageText(message));
				return fauxAssistantMessage("saw it");
			},
			fauxAssistantMessage("report read"),
		]);
		try {
			await harness.session.prompt("go");
			// The step right after the tool already carried the notice, before the follow-up report was read.
			expect(secondRequest.some((text) => text.includes("[Octocode notice] Background subagent worker done"))).toBe(
				true,
			);
			expect(secondRequest.some((text) => text.includes("Background subagent worker reported done"))).toBe(false);
			// Then the full report was delivered as before, once.
			await harness.session.agent.waitForIdle();
			const transcript = fs.readFileSync(manager.getSessionFile()!, "utf8");
			expect(transcript.split(AGENT_RESULT_TYPE).length - 1).toBe(1);
			expect(transcript).toContain(NOTICE_TYPE);
		} finally {
			queue.persist();
			harness.cleanup();
		}
	});
});
