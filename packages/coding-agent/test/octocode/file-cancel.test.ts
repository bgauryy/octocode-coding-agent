import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it, vi } from "vitest";
import { withFileMutationQueue } from "../../src/core/tools/index.ts";
import { Checkpoints } from "../../src/octocode/files/checkpoint.ts";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { currentMutationRevision } from "../../src/octocode/files/feedback/revisions.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";

function setup() {
	const cwd = fs.realpathSync(tmp());
	const file = path.join(cwd, "note.txt");
	fs.writeFileSync(file, "original");
	const guard = new FileGuard();
	guard.record(file);
	const checkpoints = new Checkpoints();
	checkpoints.open(tmp());
	checkpoints.beginTurn();
	const fake = fakeHost();
	registerFileTool(fake.api, guard, fakePermission(), checkpoints);
	return { cwd, file, guard, checkpoints, tool: fake.tools.get("file"), ctx: fakeCtx({ cwd }) };
}

describe("file cancellation around filesystem mutations", () => {
	it.each(["write", "edit", "delete"] as const)(
		"retains the %s checkpoint when lock cleanup fails after commit",
		async (type) => {
			const { file, guard, checkpoints, tool, ctx } = setup();
			const acquire = lockfile.lock.bind(lockfile);
			const locked = vi.spyOn(lockfile, "lock").mockImplementation(async (target, options) => {
				const release = await acquire(target, options);
				return async () => {
					await release();
					if (target === file) throw new Error("cleanup failed");
				};
			});
			try {
				const query = {
					type,
					path: file,
					reason: "change it",
					...(type === "write"
						? { content: "changed" }
						: type === "edit"
							? { edits: [{ oldText: "original", newText: "changed" }] }
							: {}),
				};
				const revision = currentMutationRevision(ctx.sessionManager.getSessionId());
				const result = await tool.execute("cleanup-failure", { queries: [query] }, undefined, undefined, ctx);
				expect(result.isError).toBe(true);
				expect(result.content[0].text).toMatch(/file was changed/i);
				expect(result.details.receipts).toMatchObject([
					{ canonicalPath: file, operation: type, toolCallId: "cleanup-failure", revision: revision + 1 },
				]);
				expect(checkpoints.list()).toHaveLength(1);
				if (type === "delete") expect(fs.existsSync(file)).toBe(false);
				else {
					expect(fs.readFileSync(file, "utf8")).toBe("changed");
					expect(guard.check(file, "edit", file)).toBeUndefined();
				}
			} finally {
				locked.mockRestore();
			}
			expect((await checkpoints.rewind(checkpoints.turns())).restored).toEqual([file]);
			expect(fs.readFileSync(file, "utf8")).toBe("original");
		},
	);
	it("does not delete a file when aborted while waiting for its mutation queue", async () => {
		const { file, checkpoints, tool, ctx } = setup();
		const controller = new AbortController();
		let release: () => void = () => undefined;
		const held = withFileMutationQueue(
			file,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const capture = vi.spyOn(checkpoints, "capture");
		const running = tool.execute(
			"cancel-delete",
			{ queries: [{ type: "delete", path: file, reason: "remove it" }] },
			controller.signal,
			undefined,
			ctx,
		);
		await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
		controller.abort();
		release();
		await held;
		await expect(running).rejects.toThrow(/abort/i);
		expect(fs.readFileSync(file, "utf8")).toBe("original");
		expect(checkpoints.list()).toEqual([]);
	});

	it.each(["write", "edit"] as const)(
		"reports %s as done and keeps the checkpoint if aborted after its atomic replacement",
		async (type) => {
			const { file, guard, checkpoints, tool, ctx } = setup();
			const controller = new AbortController();
			const rename = fs.promises.rename.bind(fs.promises);
			const changed = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
				await rename(from, to);
				if (to === file) controller.abort();
			});
			try {
				const query = {
					type,
					path: file,
					reason: "replace it",
					...(type === "write" ? { content: "changed" } : { edits: [{ oldText: "original", newText: "changed" }] }),
				};
				const result = await tool.execute("cancel-write", { queries: [query] }, controller.signal, undefined, ctx);
				expect(result.isError).toBeUndefined();
				expect(result.content[0].text).not.toMatch(/abort/i);
				expect(result.details.receipts).toHaveLength(1);
				expect(fs.readFileSync(file, "utf8")).toBe("changed");
				expect(checkpoints.list()).toHaveLength(1);
				expect(guard.check(file, "edit", file)).toBeUndefined();
				changed.mockRestore();
				expect((await checkpoints.rewind(checkpoints.turns())).restored).toEqual([file]);
				expect(fs.readFileSync(file, "utf8")).toBe("original");
			} finally {
				changed.mockRestore();
			}
		},
	);
});
