import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deliverRestoredFiles, RESTORE_TOTAL_CHARS } from "../../src/octocode/compaction/restore.ts";
import { recordContextFiles } from "../../src/octocode/compaction/restore-context.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { tmp } from "./helpers.ts";
import { asSetup } from "./fake-host.ts";

function setup() {
	const dir = tmp();
	const context = path.join(dir, "AGENTS.md");
	const other = path.join(dir, "notes.md");
	const text = `# Rules\n${"keep it small\n".repeat(400)}`;
	fs.writeFileSync(context, text);
	fs.writeFileSync(other, `# Notes\n${"other text\n".repeat(400)}`);
	const sent: Array<{ content: string }> = [];
	const api = asSetup({ sendMessage: (message: { content: string }) => void sent.push(message) });
	const ctx = {
		cwd: dir,
		sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ entries: [] }) },
	};
	const restore = (contextFiles: Array<{ path: string; content: string }>) => {
		const guard = new FileGuard();
		const held = recordContextFiles(guard, contextFiles);
		const pending = deliverRestoredFiles(
			api,
			[{ file: context }, { file: other }],
			ctx as never,
			RESTORE_TOTAL_CHARS,
			undefined,
			held,
		);
		return { guard, pending };
	};
	return { context, other, text, sent, restore };
}

describe("project context files after a compaction", () => {
	it("are not read back, and count as read", () => {
		const { context, other, text, sent, restore } = setup();
		const { guard, pending } = restore([{ path: context, content: text }]);
		expect(pending?.files.map((entry) => entry.file)).toEqual([other]);
		expect(sent[0].content).not.toContain("keep it small");
		expect(guard.check(context, "write", "AGENTS.md")).toBeUndefined();
	});

	it("refuse an edit once the file changed on disk after the compaction", () => {
		const { context, text, restore } = setup();
		const { guard } = restore([{ path: context, content: text }]);
		fs.writeFileSync(context, `${text}changed\n`);
		expect(guard.check(context, "write", "AGENTS.md")).toMatch(/changed on disk/);
	});

	it("are read back when the file changed since it was loaded", () => {
		const { context, text, sent, restore } = setup();
		fs.writeFileSync(context, `${text}new rule\n`);
		const { guard, pending } = restore([{ path: context, content: text }]);
		expect(pending?.files.map((entry) => entry.file)).toContain(context);
		expect(sent[0].content).toContain("new rule");
		expect(guard.check(context, "write", "AGENTS.md")).toMatch(/not read/);
	});
});
