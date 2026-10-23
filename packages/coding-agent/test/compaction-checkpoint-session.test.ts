import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness } from "./suite/harness.ts";

it.each(["manual", "threshold", "overflow"] as const)(
	"preserves the complete checkpoint before committing %s compaction, and leaves history intact on write failure",
	async (reason) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-session-"));
		const manager = SessionManager.create(directory, path.join(directory, "sessions"));
		const complete = "Complete checkpoint 😀\n".repeat(5000);
		const harness = await createHarness({
			sessionManager: manager,
			models: [{ id: "small", contextWindow: 8000 }],
			tools: [],
			compactionPolicy: { keepRecentTokens: 1 },
			builtinCompactionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: complete,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		const seed = () => {
			manager.appendMessage({ role: "user", content: "Original instruction", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("Complete answer"));
			harness.session.refreshContext();
		};
		const compact = () =>
			reason === "manual"
				? harness.session.compact()
				: (
						harness.session as unknown as {
							_runAutoCompaction(reason: "threshold" | "overflow", retry: boolean): Promise<boolean>;
						}
					)._runAutoCompaction(reason, reason === "overflow");
		try {
			seed();
			await compact();
			const saved = manager.getEntries().filter((entry) => entry.type === "compaction");
			expect(saved).toHaveLength(1);
			const archive = (saved[0].details as { checkpointArchive: { path: string; summary: string } }).checkpointArchive;
			expect(fs.readFileSync(archive.path, "utf8")).toBe(complete);
			expect(archive.summary).toBe(complete);
			expect(saved[0].summary).toContain(archive.path);
			expect(fs.readFileSync(manager.getSessionFile()!, "utf8")).toContain("Original instruction");
			seed();
			const before = manager.getBranch();
			const projection = manager.buildSessionProjection();
			const sessionFile = manager.getSessionFile;
			manager.getSessionFile = () => path.join(archive.path, "impossible.jsonl");
			if (reason === "manual") await expect(compact()).rejects.toThrow(/persist/);
			else expect(await compact()).toBe(false);
			manager.getSessionFile = sessionFile;
			expect(manager.getBranch()).toEqual(before);
			expect(manager.buildSessionProjection()).toEqual(projection);
			expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		} finally {
			harness.cleanup();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	},
);
