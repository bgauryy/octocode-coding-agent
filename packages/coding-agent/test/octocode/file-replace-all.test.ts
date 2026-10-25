import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { Checkpoints } from "../../src/octocode/files/checkpoint.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { hookCalls } from "../../src/octocode/hooks/config/calls.ts";
import { fakeCtx, fakePermission, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";
function setup(content = "A\nA\n", partial = false) {
	const cwd = fs.realpathSync(tmp()),
		file = path.join(cwd, "file");
	fs.writeFileSync(file, content);
	const guard = new FileGuard();
	guard.record(file, undefined, partial, partial ? [1, 1] : undefined);
	const checkpoints = new Checkpoints();
	checkpoints.open(tmp());
	checkpoints.beginTurn();
	const fake = fakePi();
	registerFileTool(fake.pi, guard, fakePermission(), checkpoints);
	const tool = fake.tools.get("file")!,
		ctx = fakeCtx({ cwd });
	const edit = (replaceAll = true, signal?: AbortSignal) =>
		tool.execute(
			"edit-all",
			{
				queries: [
					{
						type: "edit",
						path: file,
						reason: "test",
						edits: [{ oldText: "A", newText: "B", replaceAll }],
					},
				],
			},
			signal,
			undefined,
			ctx,
		);
	return { file, guard, checkpoints, edit, tool, ctx };
}
it("keeps partial-read coverage after replacing seen and unseen occurrences", async () => {
	const f = setup(undefined, true);
	await f.edit();
	expect(fs.readFileSync(f.file, "utf8")).toBe("B\nB\n");
	expect(f.guard.check(f.file, "write", f.file)).toMatch(/seen|Read the rest/);
	f.guard.record(f.file);
	expect(f.guard.check(f.file, "write", f.file)).toBeUndefined();
});
it("preserves stale prefixes and new matching occurrences without upgrading read state", async () => {
	const f = setup();
	fs.writeFileSync(f.file, "PEER\nA\nA\nA\n");
	await f.edit();
	expect(fs.readFileSync(f.file, "utf8")).toBe("PEER\nB\nB\nB\n");
	expect(f.guard.check(f.file, "write", f.file)).toMatch(/changed on disk/);
});
it("does not relax default uniqueness or context-evicted read guards", async () => {
	const f = setup();
	await expect(f.edit(false)).rejects.toThrow(/unique/);
	f.guard.forget(f.file);
	await expect(f.edit()).rejects.toThrow(/context/);
	expect(fs.readFileSync(f.file, "utf8")).toBe("A\nA\n");
});
it("retains checkpoint and cancellation semantics after an all-occurrence commit", async () => {
	const f = setup();
	const controller = new AbortController();
	const rename = fs.promises.rename.bind(fs.promises);
	const spy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
		await rename(from, to);
		if (to === f.file) controller.abort();
	});
	try {
		const result = await f.edit(true, controller.signal);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/abort[\s\S]*changed/i);
		expect(result.details.receipts).toHaveLength(1);
		expect(fs.readFileSync(f.file, "utf8")).toBe("B\nB\n");
		expect(f.checkpoints.list()).toHaveLength(1);
	} finally {
		spy.mockRestore();
	}
	await f.checkpoints.rewind(f.checkpoints.turns());
	expect(fs.readFileSync(f.file, "utf8")).toBe("A\nA\n");
});
it("projects the explicit flag in original and effective source file inputs", () => {
	const input = {
		queries: [
			{
				type: "edit",
				path: "f",
				edits: [{ oldText: "A", newText: "B", replaceAll: true }],
			},
		],
	};
	expect(hookCalls("file", input, "/repo")[0].tool_input).toMatchObject({
		old_string: "A",
		new_string: "B",
		replace_all: true,
	});
});
