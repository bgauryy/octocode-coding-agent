import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import type { FeatureSetup } from "../../src/core/features/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import { createHarness } from "../suite/harness.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";

describe("report delivery through the real session runtime", () => {
	it("retries a rejected run preparation in the same session and acknowledges one recorded report", async () => {
		let host!: FeatureSetup;
		const root = tmp();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const harness = await createHarness({
			sessionManager: manager,
			features: testFeatures([
				(api) => {
					host = api;
				},
			]),
		});
		const errors: string[] = [];
		await harness.session.bindFeatures({ onError: (error) => errors.push(error.error) });
		const queue = new ReportQueue(host);
		queue.start(manager);
		queue.pendingDir = path.join(root, "reports");
		const preparation = vi
			.spyOn(harness.session as unknown as { _prepareRun(): Promise<never> }, "_prepareRun")
			.mockRejectedValueOnce(new Error("preparation rejected"));
		try {
			queue.add({
				content: "done: important result",
				details: { id: "worker", status: "done", summary: "Done" },
				wake: true,
			});
			queue.flush();
			await vi.waitFor(() => expect(errors).toContain("preparation rejected"));
			queue.recorded();
			expect(fs.readdirSync(queue.pendingDir)).toHaveLength(1);
			expect(manager.getEntries().filter((entry) => entry.type === "custom_message")).toEqual([]);
			preparation.mockRestore();
			harness.setResponses([fauxAssistantMessage("received")]);
			// The live queue retries the rejected send without restarting or taking its saved claim.
			await vi.waitFor(
				() => expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(true),
				{ timeout: 5000 },
			);
			expect(manager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
			queue.recorded();
			expect(fs.readdirSync(queue.pendingDir)).toEqual([]);
			expect(fs.readFileSync(manager.getSessionFile()!, "utf8")).toContain("important result");
		} finally {
			preparation.mockRestore();
			queue.persist();
			harness.cleanup();
		}
	});

	it("does not treat buffered setup entries as a durable transcript receipt", async () => {
		let host!: FeatureSetup;
		const root = tmp();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const harness = await createHarness({
			sessionManager: manager,
			features: testFeatures([
				(api) => {
					host = api;
				},
			]),
		});
		await harness.session.bindFeatures({});
		const queue = new ReportQueue(host);
		queue.start(manager);
		queue.pendingDir = path.join(root, "reports");
		try {
			queue.add({
				content: "stopped result",
				details: { id: "worker", status: "stopped", summary: "Stopped" },
				wake: false,
			});
			queue.flush();
			expect(manager.getEntries().some((entry) => entry.type === "custom_message")).toBe(true);
			expect(fs.existsSync(manager.getSessionFile()!)).toBe(false);
			expect(fs.readdirSync(queue.pendingDir)).toHaveLength(1);
			harness.setResponses([fauxAssistantMessage("ready")]);
			await harness.session.prompt("continue");
			queue.recorded();
			expect(fs.readdirSync(queue.pendingDir)).toEqual([]);
		} finally {
			queue.persist();
			harness.cleanup();
		}
	});
	const reportsDuringReply = async (ids: string[], after?: (queue: ReportQueue) => void) => {
		let host!: FeatureSetup;
		const root = tmp();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const harness = await createHarness({
			sessionManager: manager,
			features: testFeatures([
				(api) => {
					host = api;
				},
			]),
		});
		await harness.session.bindFeatures({});
		const queue = new ReportQueue(host);
		queue.start(manager, undefined, undefined, (details, content) =>
			harness.session.replaceQueuedCustomMessage(details, content),
		);
		queue.pendingDir = path.join(root, "reports");
		const requests: string[][] = [];
		const reply = (text: string) => (context: { messages: unknown[] }) => {
			requests.push(context.messages.map((message) => JSON.stringify(message)));
			return fauxAssistantMessage(text);
		};
		harness.setResponses([
			(context) => {
				// Each finishes in its own batch, as children do seconds apart: one send per report, all while the parent replies.
				for (const id of ids) {
					queue.add({
						content: `Background subagent ${id} reported done. ${id} is waiting for your reply.`,
						details: { id, status: "done", summary: "Done" },
						wake: true,
					});
					queue.flush();
				}
				after?.(queue);
				return reply("first")(context);
			},
			reply("second"),
			reply("third"),
			reply("fourth"),
		]);
		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();
		queue.recorded();
		queue.persist();
		harness.cleanup();
		return { requests, transcript: fs.readFileSync(manager.getSessionFile()!, "utf8") };
	};

	it("hands every report waiting when the parent would stop to one turn", async () => {
		const { requests } = await reportsDuringReply(["alpha", "beta", "gamma"]);
		expect(requests).toHaveLength(2);
		for (const id of ["alpha", "beta", "gamma"]) expect(requests[1].join("\n")).toContain(`subagent ${id} reported`);
	});

	it("leaves a follow-up without the option one per turn", async () => {
		let host!: FeatureSetup;
		const harness = await createHarness({
			features: testFeatures([
				(api) => {
					host = api;
				},
			]),
		});
		try {
			await harness.session.bindFeatures({});
			const send = (content: string, together: boolean) =>
				void host.session.sendMessage(
					{ customType: "note", content, display: false },
					{ triggerTurn: true, deliverAs: "followUp", together },
				);
			let requests = 0;
			const reply = () => {
				requests += 1;
				return fauxAssistantMessage(`reply ${requests}`);
			};
			harness.setResponses([
				() => {
					// The middle one divides the two together-messages: its order and its own turn stay as they were.
					send("first", true);
					send("own", false);
					send("second", true);
					return reply();
				},
				reply,
				reply,
				reply,
			]);
			await harness.session.prompt("start");
			await harness.session.agent.waitForIdle();
			expect(requests).toBe(4);
		} finally {
			harness.cleanup();
		}
	});

	it("marks an unread report superseded when its run resumes, and the parent reads and records the mark", async () => {
		const { requests, transcript } = await reportsDuringReply(["alpha"], (queue) => queue.supersede("alpha"));
		const read = requests[1].join("\n");
		expect(read).toContain("alpha is waiting for your reply");
		expect(read).toContain("alpha was resumed after it wrote this report");
		expect(transcript).toContain("alpha was resumed after it wrote this report");
	});
});
