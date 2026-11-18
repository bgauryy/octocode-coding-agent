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
	it("reads an edited file back whole and a file only read as its outline, newest work first", async () => {
		const dir = tmp();
		fs.writeFileSync(path.join(dir, "edited.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(dir, "looked.ts"), code("looked"));
		const { restored, byFile } = await restoredIn(dir, [
			...read("1", "looked.ts", 100),
			...edit("2", "edited.ts", 200),
		]);
		expect(byFile.get("edited.ts")?.whole).toBe(true);
		expect(byFile.get("looked.ts")?.whole).toBe(false);
		expect(restored?.content).toContain("export const a = 1;");
		// The outline lists declarations, not their bodies.
		expect(restored?.content).toContain("looked0");
		expect(restored?.content).not.toContain("return value + 0;");
		expect(restored?.files.map((entry) => path.basename(entry.file))).toEqual(["edited.ts", "looked.ts"]);
	});

	it("skips a file only read that has no declaration to outline, small or not, and a dependency's file only read", async () => {
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
		expect(restored).toBeUndefined();
	});

	it("never reads back scratch: .octocode/tmp or .octocode/code/temp, edited or not", async () => {
		const dir = tmp();
		const scratch = [".octocode/tmp/plan.ts", ".octocode/code/temp/agents/a/out.ts"];
		for (const file of scratch) {
			fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			fs.writeFileSync(path.join(dir, file), "export const s = 1;\n");
		}
		fs.mkdirSync(path.join(dir, ".octocode/roast"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".octocode/roast/kept.ts"), "export const k = 1;\n");
		const { candidates } = await restoredIn(dir, [
			...edit("1", scratch[0], 100),
			...edit("2", scratch[1], 200),
			...edit("3", ".octocode/roast/kept.ts", 300),
		]);
		expect(candidates.map((candidate) => path.relative(dir, candidate.file))).toEqual([".octocode/roast/kept.ts"]);
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
			// A file only read stays an outline.
			expect(byFile.get("looked.ts")?.whole).toBe(false);
		}
		// Without the earlier summary's modified list, the read-back alone is no change.
		const { byFile } = await restoredIn(dir, span);
		expect(byFile.get("edited.ts")?.whole).toBe(false);
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
