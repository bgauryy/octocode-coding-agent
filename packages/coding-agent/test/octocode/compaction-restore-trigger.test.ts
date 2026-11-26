import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deliverRestoredFiles, RESTORE_TOTAL_CHARS } from "../../src/octocode/compaction/restore.ts";
import { tmp } from "./helpers.ts";
import { asSetup } from "./fake-host.ts";

// About 39k tokens of history: the lowest trigger the limits allow (40k) leaves about a thousand tokens of room.
const history = { role: "user", content: "x".repeat(150_000), timestamp: 0 };
const model = { provider: "p", id: "m", contextWindow: 200_000 };

/** Restores one large file with `limits` in the settings; returns the characters sent. */
async function restoredChars(limits: Record<string, unknown>): Promise<number> {
	const dir = tmp();
	const file = path.join(dir, "big.ts");
	fs.writeFileSync(file, Array.from({ length: 4_000 }, (_, i) => `row ${i} ${"x".repeat(30)}\n`).join(""));
	const sent: Array<{ content: string }> = [];
	const api = asSetup({
		sendMessage: (message: never) => void sent.push(message),
		getSettings: () => ({ limits }),
	});
	const ctx = {
		cwd: dir,
		model,
		sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ entries: [], messages: [history] }) },
	};
	await deliverRestoredFiles(api, [{ file }], ctx as never, RESTORE_TOTAL_CHARS);
	return sent.reduce((sum, message) => sum + message.content.length, 0);
}

describe("restored files and the session's compaction trigger", () => {
	it("shrink when limits.compaction.trigger leaves less room than the default point", async () => {
		const normal = await restoredChars({});
		const lowTrigger = await restoredChars({ compaction: { trigger: 40_000 } });
		expect(normal).toBeGreaterThan(0);
		expect(lowTrigger).toBeLessThan(normal);
	});

	it("surfaces a malformed projection instead of skipping the restore", async () => {
		const api = asSetup({ sendMessage: () => undefined, getSettings: () => ({}) });
		const ctx = {
			cwd: tmp(),
			model,
			sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ entries: [], messages: null }) },
		};
		await expect(deliverRestoredFiles(api, [{ file: "x" }], ctx as never, RESTORE_TOTAL_CHARS)).rejects.toThrow();
	});
});
