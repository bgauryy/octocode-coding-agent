import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "../../src/octocode/files/checkpoint.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A file whose read a compaction dropped (`restore([])`), with the file tool registered over the same guard. */
function droppedRead(content = "alpha\nbeta\ngamma\n") {
	const cwd = fs.realpathSync(tmp());
	const file = path.join(cwd, "notes.txt");
	fs.writeFileSync(file, content);
	const guard = new FileGuard();
	guard.record(file);
	guard.restore([]);
	const checkpoints = new Checkpoints();
	checkpoints.open(tmp());
	checkpoints.beginTurn();
	const host = fakeHost();
	registerFileTool(host.api, guard, fakePermission(), checkpoints);
	const tool = host.tools.get("file")!;
	const ctx = fakeCtx({ cwd });
	const run = (query: Record<string, unknown>) =>
		tool.execute("call", { queries: [{ path: file, reason: "test", ...query }] }, undefined, undefined, ctx);
	return { file, guard, run };
}

describe("a read a compaction dropped", () => {
	it("lets an edit go on when every oldText matches exactly, as for a file never read", async () => {
		const { file, guard, run } = droppedRead();
		expect(guard.inspect(file, "edit", "notes.txt")).toMatchObject({ stale: true, unread: true });
		const result = await run({ type: "edit", edits: [{ oldText: "beta", newText: "BETA" }] });
		expect(result.details.outcomes[0]).toMatchObject({ ok: true });
		expect(fs.readFileSync(file, "utf8")).toBe("alpha\nBETA\ngamma\n");
	});

	it("refuses an edit whose oldText does not match, and leaves the file alone", async () => {
		const { file, run } = droppedRead();
		await expect(run({ type: "edit", edits: [{ oldText: "delta", newText: "DELTA" }] })).rejects.toThrow(
			/edits\[0\] oldText was not found in it/,
		);
		expect(fs.readFileSync(file, "utf8")).toBe("alpha\nbeta\ngamma\n");
	});

	it("refuses an edit whose oldText matches more than once", async () => {
		const { file, run } = droppedRead("x\nx\n");
		await expect(run({ type: "edit", edits: [{ oldText: "x", newText: "y" }] })).rejects.toThrow(/matches it 2 times/);
		expect(fs.readFileSync(file, "utf8")).toBe("x\nx\n");
	});

	it("still refuses a write and a delete until the file is read again", async () => {
		const { file, guard, run } = droppedRead();
		for (const mode of ["write", "delete"] as const)
			expect(guard.check(file, mode, "notes.txt")).toMatch(/no longer in your context/);
		await expect(run({ type: "write", content: "new\n" })).rejects.toThrow(/no longer in your context/);
		await expect(run({ type: "delete" })).rejects.toThrow(/no longer in your context/);
		expect(fs.readFileSync(file, "utf8")).toBe("alpha\nbeta\ngamma\n");
		guard.record(file);
		expect(guard.check(file, "write", "notes.txt")).toBeUndefined();
	});
});
