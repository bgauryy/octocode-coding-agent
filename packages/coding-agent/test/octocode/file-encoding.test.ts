import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { sha256 } from "../../../common/src/atomic-file.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A file that is not UTF-8 (Latin-1 here) must not be rewritten through a UTF-8 decode that replaces its other bytes. */
describe("file tool: content that is not UTF-8", () => {
	// "café" in Latin-1 (0xE9), then an ASCII line the change targets.
	const original = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, ...Buffer.from("name = old\n")]);

	async function run(input: Record<string, unknown>) {
		const cwd = tmp();
		const file = path.join(cwd, "latin1.txt");
		fs.writeFileSync(file, original);
		const guard = new FileGuard();
		guard.record(file, { sha256: sha256(original), size: original.length });
		const { api, tools } = fakeHost();
		registerFileTool(api, guard, fakePermission());
		const text = await tools
			.get("file")
			.execute("change", input, undefined, undefined, fakeCtx({ cwd }))
			.then(
				(result: { content: Array<{ text?: string }> }) => result.content.map((part) => part.text ?? "").join("\n"),
				(error: Error) => error.message,
			);
		return { bytes: fs.readFileSync(file), text };
	}

	it("refuses an edit instead of replacing the bytes it cannot decode", async () => {
		const { bytes, text } = await run({
			queries: [
				{
					type: "edit",
					path: "latin1.txt",
					reason: "rename",
					edits: [{ oldText: "name = old", newText: "name = new" }],
				},
			],
		});
		expect(bytes).toEqual(original);
		expect(text).toContain("not valid UTF-8");
	});

	it("refuses a patch update the same way", async () => {
		const { bytes, text } = await run({
			patch: "*** Begin Patch\n*** Update File: latin1.txt\n@@\n-name = old\n+name = new\n*** End Patch",
		});
		expect(bytes).toEqual(original);
		expect(text).toContain("not valid UTF-8");
	});
});
