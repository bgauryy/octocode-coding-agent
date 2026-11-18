import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { recordLockOwner } from "@octocodeai/octocode-common/lock-owner";
import { createHarness } from "./harness.ts";

const lockfile = createRequire(new URL("../../src/core/session-manager/shared-file.ts", import.meta.url))(
	"proper-lockfile",
);

describe("how a run ended", () => {
	it("reports nothing before the first run, then a new completed outcome per run with its usage", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		expect(harness.session.lastRunOutcome).toBeUndefined();
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		const first = harness.session.lastRunOutcome;
		expect(first?.status).toBe("completed");
		await harness.session.prompt("second");
		expect(harness.session.lastRunOutcome).not.toBe(first);
		harness.cleanup();
	});

	it("names the failure and survives the failed attempt leaving the context", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 900000 tokens > 200000" }),
		]);
		await harness.session.prompt("too big");
		const last = harness.session.messages.at(-1);
		expect(last?.role === "assistant" && last.stopReason === "error").toBe(false);
		const outcome = harness.session.lastRunOutcome;
		expect(outcome?.status).toBe("failed");
		expect(outcome?.errorMessage).toMatch(/overflow recovery failed|too long/i);
		harness.cleanup();
	});

	it("lets a later good message supersede a retried failure", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 internal server error" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("go");
		expect(harness.session.lastRunOutcome?.status).toBe("completed");
		expect(harness.session.lastRunOutcome?.errorMessage).toBeUndefined();
		harness.cleanup();
	});

	it("reports an output-limit stop as truncated, and carries the outcome on agent_settled", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		const settled: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.push(event.outcome);
		});
		harness.setResponses([fauxAssistantMessage("cut", { stopReason: "length" })]);
		await harness.session.prompt("go");
		expect(harness.session.lastRunOutcome?.status).toBe("truncated");
		expect(settled).toEqual([harness.session.lastRunOutcome]);
		harness.cleanup();
	});

	it("records a failed preparation, so a later reader does not see a success", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harness.session.featureHost.emitBeforeAgentStart = async () => {
			throw new Error("handler broke");
		};
		await expect(harness.session.prompt("go")).rejects.toThrow("handler broke");
		expect(harness.session.lastRunOutcome?.status).toBe("failed");
		expect(harness.session.lastRunOutcome?.errorMessage).toBe("handler broke");
		harness.cleanup();
	});
});

describe("a write failure at the end of a run", () => {
	/** A tool that queues a message for the end of the run and takes the session lock, so the run's next appends fail. */
	async function wedgeAttempt() {
		const box: { session?: any } = {};
		let release: (() => void) | undefined;
		const dir = mkdtempSync(join(tmpdir(), "octocode-run-outcome-"));
		const harness = await createHarness({
			sessionManager: SessionManager.create(dir, dir),
			cwd: dir,
			settings: { retry: { enabled: false } },
			tools: [
				{
					name: "t",
					label: "t",
					description: "t",
					parameters: Type.Object({}),
					execute: async () => {
						await box.session.sendCustomMessage(
							{ customType: "note", content: "held", display: false },
							{ triggerTurn: false },
						);
						const file = box.session.sessionManager.getSessionFile();
						const unlock = lockfile.lockSync(file, { realpath: false, lockfilePath: `${file}.lock` });
						const forget = recordLockOwner(`${file}.lock`);
						release = () => {
							try {
								unlock();
							} finally {
								forget();
							}
						};
						return { content: [{ type: "text", text: "ok" }], details: {} };
					},
				},
			],
		});
		box.session = harness.session;
		await harness.session.bindFeatures({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("t", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("second"),
		]);
		return {
			harness,
			dir,
			release: () => {
				const unlock = release;
				release = undefined;
				unlock?.();
			},
		};
	}

	it("still settles, so abort, waits and the next prompt do not hang", async () => {
		const { harness, dir, release } = await wedgeAttempt();
		try {
			// The reply was produced, so a record the lock holds back does not fail the run: it stays in memory, part of the
			// session at once, and the timed retry writes it once the lock is free (`held-retry.ts`).
			await harness.session.prompt("go");
			expect(harness.session.lastRunOutcome?.status).toBe("completed");
			const file = harness.session.sessionManager.getSessionFile()!;
			expect(harness.session.sessionManager.getEntries().some((entry: any) => entry.content === "held")).toBe(true);
			expect(readFileSync(file, "utf8")).not.toContain('"content":"held"');
			expect(harness.session.isStreaming).toBe(false);
			expect(harness.session.isIdle).toBe(true);
			await harness.session.waitForIdle();
			await harness.session.abort();
			release();
			await vi.waitFor(() => expect(readFileSync(file, "utf8")).toContain('"content":"held"'), { timeout: 5000 });
			await harness.session.prompt("again");
			expect(harness.session.lastRunOutcome?.status).toBe("completed");
		} finally {
			release();
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30000);
});
