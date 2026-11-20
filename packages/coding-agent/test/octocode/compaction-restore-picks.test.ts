import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESTORED_FILES_TYPE } from "../../src/octocode/files/reads.ts";
import { restoreFiles } from "../../src/octocode/compaction/restore.ts";
import { restoreCandidates } from "../../src/octocode/compaction/restore-picks.ts";
import { tmp } from "./helpers.ts";

const call = (id: string, name: string, args: Record<string, unknown>) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, toolName: string, timestamp: number, details?: Record<string, unknown>) => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	content: [{ type: "text", text: "" }],
	isError: false,
	timestamp,
	...(details ? { details } : {}),
});
const read = (id: string, file: string, at: number) => [call(id, "read", { path: file }), result(id, "read", at)];
const edit = (id: string, file: string, at: number) => [
	call(id, "file", { queries: [] }),
	result(id, "file", at, { outcomes: [{ ok: true, path: file }] }),
];
const code = (name: string) =>
	Array.from(
		{ length: 40 },
		(_, i) => `export function ${name}${i}(value: number): number {\n\treturn value + ${i};\n}\n`,
	).join("\n");

async function restoredIn(dir: string, messages: unknown[], branch: unknown[] = []) {
	const candidates = await restoreCandidates(
		{ messagesToSummarize: messages as never, turnPrefixMessages: [] },
		dir,
		branch as never,
	);
	const restored = restoreFiles(candidates, new Set(), dir, 200_000);
	return { candidates, restored, byFile: new Map(restored?.files.map((entry) => [path.basename(entry.file), entry])) };
}

describe("what comes back after a compaction", () => {
	it("reads an edited file back whole and only names a file only read, with the line last read, newest work first", async () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "edited.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(dir, "looked.ts"), code("looked"));
		const { restored, byFile } = await restoredIn(dir, [
			...read("1", "looked.ts", 100),
			...edit("2", "edited.ts", 200),
		]);
		expect(byFile.get("edited.ts")?.whole).toBe(true);
		expect(restored?.content).toContain("export const a = 1;");
		// The file only read is not read back: no outline, no text, only its path in one line after the files.
		expect(byFile.has("looked.ts")).toBe(false);
		expect(restored?.content).not.toContain("looked0");
		expect(restored?.listed).toEqual(["looked.ts"]);
		expect(restored?.content.split("\n").at(-1)).toMatch(/not restored.*: looked\.ts\.$/);
		expect(restored?.files.map((entry) => path.basename(entry.file))).toEqual(["edited.ts"]);
	});

	it("names files only read even when nothing is read back, but not a dependency's file", async () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "notes.md"), "plain words\n".repeat(50));
		fs.writeFileSync(path.join(dir, "tiny.txt"), "x\n");
		fs.mkdirSync(path.join(dir, "node_modules/dep"), { recursive: true });
		fs.writeFileSync(path.join(dir, "node_modules/dep/index.ts"), code("dep"));
		const { restored } = await restoredIn(dir, [
			...read("1", "notes.md", 100),
			...read("2", "tiny.txt", 200),
			...read("3", "node_modules/dep/index.ts", 300),
		]);
		expect(restored?.files).toEqual([]);
		expect(restored?.listed).toEqual(["tiny.txt", "notes.md"]);
		expect(restored?.content).toMatch(/^\[After compaction\] Read before this summary and not restored/);
		expect(restored?.content).not.toContain("plain words");
	});

	it("never reads back anything under .octocode/, edited or not, but does read back a worktree checkout's own files", async () => {
		const dir = tmp();
		const octocode = [".octocode/tmp/plan.ts", ".octocode/code/temp/agents/a/out.ts", ".octocode/roast/report.ts"];
		const worktree = ".octocode/worktrees/fix-a/src/kept.ts";
		for (const file of [...octocode, worktree, ".octocode/worktrees/fix-a/.octocode/tmp/x.ts"]) {
			fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			fs.writeFileSync(path.join(dir, file), "export const s = 1;\n");
		}
		const { candidates } = await restoredIn(dir, [
			...edit("1", octocode[0], 100),
			...edit("2", octocode[1], 200),
			...edit("3", octocode[2], 300),
			...edit("4", worktree, 400),
			...edit("5", ".octocode/worktrees/fix-a/.octocode/tmp/x.ts", 500),
		]);
		expect(candidates.map((candidate) => path.relative(dir, candidate.file))).toEqual([worktree]);
		// A session working inside the worktree gets its own files back.
		const inside = await restoreCandidates(
			{ messagesToSummarize: edit("6", "src/kept.ts", 600) as never, turnPrefixMessages: [] },
			path.join(dir, ".octocode/worktrees/fix-a"),
			[],
		);
		expect(inside.map((candidate) => path.basename(candidate.file))).toEqual(["kept.ts"]);
	});

	it("after a second compaction, reads a file edited before the first back whole, as the first did", async () => {
		const dir = tmp();
		const edited = path.join(dir, "edited.ts");
		fs.writeFileSync(edited, code("edited"));
		fs.writeFileSync(path.join(dir, "looked.ts"), code("looked"));
		// The span after the first compaction holds the edited file only as that compaction's read-back.
		const span = [
			{
				role: "custom",
				customType: RESTORED_FILES_TYPE,
				content: "",
				display: false,
				timestamp: 100,
				details: { files: [edited], worked: [{ file: edited, workedAt: 50 }] },
			},
			...read("1", "looked.ts", 200),
		];
		const compaction = (fromHook: boolean) => ({
			type: "compaction",
			id: "c1",
			summary: "",
			fromHook,
			details: { readFiles: [], modifiedFiles: ["edited.ts"] },
		});
		for (const fromHook of [true, false]) {
			const { byFile, restored } = await restoredIn(dir, span, [compaction(fromHook)]);
			expect(byFile.get("edited.ts")?.whole).toBe(true);
			expect(restored?.content).toContain("return value + 0;");
			// A file only read stays a name.
			expect(byFile.has("looked.ts")).toBe(false);
			expect(restored?.listed).toEqual(["looked.ts"]);
		}
		// Without the earlier summary's modified list, the read-back alone is no change.
		const { byFile, restored } = await restoredIn(dir, span);
		expect(byFile.has("edited.ts")).toBe(false);
		expect(restored?.listed).toEqual(["looked.ts", "edited.ts"]);
	});

	it("counts a file the session's own bash wrote as edited", async () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "gen.ts"), "export const g = 1;\n");
		const messages = [
			...read("1", "gen.ts", 100),
			call("2", "bash", { command: "sed -i 's/1/2/' gen.ts" }),
			result("2", "bash", 200),
		];
		const { byFile } = await restoredIn(dir, messages);
		expect(byFile.get("gen.ts")?.whole).toBe(true);
	});
});
