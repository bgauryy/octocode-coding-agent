import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { sessionMirrorSettled } from "../../../src/core/session-manager/mirror.ts";
import { createHarness } from "../harness.ts";

it("keeps one active checkpoint and a bounded recent tail through repeated compaction and disk resume", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repeated-compaction-"));
	const manager = SessionManager.create(directory, path.join(directory, "sessions"));
	let cycle = 0;
	const harness = await createHarness({
		sessionManager: manager,
		tools: [],
		compactionPolicy: { keepRecentTokens: 100 },
		builtinCompactionFactories: [
			(api) => {
				api.bus.on("session_before_compact", async (event) => ({
					compaction: {
						summary: `Checkpoint ${cycle}: retain the goal; B7 remains blocked on agent:worker and job:verify.`,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
	try {
		for (cycle = 1; cycle <= 24; cycle++) {
			manager.appendMessage({
				role: "user",
				content: `Request ${cycle}: ${"detail ".repeat(250)}`,
				timestamp: Date.now(),
			});
			manager.appendMessage(fauxAssistantMessage(`Result ${cycle}: ${"evidence ".repeat(200)}`));
			harness.session.refreshContext();
			await harness.session.compact();
			const projection = manager.buildSessionProjection();
			expect(projection.messages.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
			expect(JSON.stringify(projection.messages)).toContain(`Checkpoint ${cycle}:`);
			expect(JSON.stringify(projection.messages)).toContain("B7 remains blocked on agent:worker and job:verify");
			expect(projection.messages.length).toBeLessThanOrEqual(5);
			expect(harness.session.messages).toEqual(projection.messages);
			const resumed = SessionManager.open(manager.getSessionFile()!);
			expect(resumed.buildSessionProjection()).toEqual(projection);
			expect(resumed.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(cycle);
		}
		const transcript = fs.readFileSync(manager.getSessionFile()!, "utf8");
		for (let request = 1; request <= 24; request++) expect(transcript).toContain(`Request ${request}:`);
	} finally {
		await sessionMirrorSettled();
		harness.cleanup();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
