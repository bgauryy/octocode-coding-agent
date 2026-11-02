import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/features/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import { createHarness } from "../suite/harness.ts";
import { tmp } from "./helpers.ts";

describe("report delivery through the real session runtime", () => {
	it("retries a rejected run preparation in the same session and acknowledges one recorded report", async () => {
		let host!: ExtensionAPI;
		const root = tmp();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(api) => {
					host = api;
				},
			],
		});
		const errors: string[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		const queue = new ReportQueue(host, 60_000);
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
		let host!: ExtensionAPI;
		const root = tmp();
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(api) => {
					host = api;
				},
			],
		});
		await harness.session.bindExtensions({});
		const queue = new ReportQueue(host, 60_000);
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
});
