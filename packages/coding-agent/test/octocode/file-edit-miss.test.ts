import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

function setup(content: string) {
	const cwd = fs.realpathSync(tmp());
	const file = path.join(cwd, "a.ts");
	fs.writeFileSync(file, content);
	const guard = new FileGuard();
	guard.record(file, { sha256: sha256(content), size: Buffer.byteLength(content) });
	const { api, tools } = fakeHost();
	registerFileTool(api, guard, fakePermission());
	const edit = (edits: Array<{ oldText: string; newText: string }>) =>
		tools
			.get("file")
			.execute(
				"c",
				{ reason: "r", queries: [{ path: "a.ts", type: "edit", edits }] },
				undefined,
				undefined,
				fakeCtx({ cwd }),
			);
	return { file, edit };
}

const SOURCE = [
	"export function total(items: number[]) {",
	"\tlet sum = 0;",
	"\tfor (const item of items) sum += item * 2;",
	"\treturn sum;",
	"}",
	"",
].join("\n");

describe("an edit miss names the nearest text of the file", () => {
	it("shows the file's lines with their numbers when a word differs, and leaves the file alone", async () => {
		const { file, edit } = setup(SOURCE);
		const failure = await edit([
			{ oldText: "\tfor (const value of items) sum += value * 2;\n\treturn sum;", newText: "x" },
		]).catch((error: Error) => error);
		const message = String(failure.message);
		expect(message).toMatch(/Could not find the exact text in a\.ts/);
		expect(message).toContain("Nearest text in the file (lines 3-4)");
		expect(message).toContain('3: "\\tfor (const item of items) sum += item * 2;"');
		expect(message).toContain('4: "\\treturn sum;"');
		expect(fs.readFileSync(file, "utf8")).toBe(SOURCE);
	});

	it("does not loosen matching: the near text is not applied", async () => {
		const { file, edit } = setup(SOURCE);
		await expect(edit([{ oldText: "let sum = 10;", newText: "let sum = 1;" }])).rejects.toThrow(/Nearest text/);
		expect(fs.readFileSync(file, "utf8")).toBe(SOURCE);
	});

	it("adds no region when nothing in the file is similar", async () => {
		const { edit } = setup(SOURCE);
		const failure = await edit([{ oldText: "zebra crossing ahead", newText: "x" }]).catch((error: Error) => error);
		expect(String(failure.message)).not.toMatch(/Nearest text/);
	});
});
