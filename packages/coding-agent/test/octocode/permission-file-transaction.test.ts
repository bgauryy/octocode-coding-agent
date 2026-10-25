import fs from "node:fs";
import path from "node:path";
import type { ToolInvocation } from "../../src/core/extensions/types.ts";
import { expect, it, vi } from "vitest";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
function setup(queries: any[], replacements: any[]) {
	const fake = fakePi();
	const cwd = tmp();
	const ctx = Object.assign(fakeCtx({ cwd, hasUI: false }), {
		invocation: undefined as ToolInvocation | undefined,
	});
	const permission = new Permission({
		pi: fake.pi,
		env: { OCTOCODE_PERMISSION: "manual" },
		isSubagent: false,
	});
	permission.start(ctx);
	const params = { queries };
	ctx.invocation = captureToolInvocation("file-one", "file", params);
	const resolver = vi.fn(async () => ({
		decision: "allow" as const,
		updatedFileInputs: replacements,
	}));
	permission.setResolver(resolver);
	const guard = new FileGuard();
	const refresh = vi.fn(async () => {});
	registerFileTool(fake.pi, guard, permission, undefined, {
		enabled: () => true,
		refresh,
	});
	return {
		cwd,
		ctx,
		params,
		guard,
		permission,
		resolver,
		refresh,
		run: () => fake.tools.get("file")!.execute("file-one", params, undefined, undefined, ctx),
	};
}
const write = (name: string, content = "original") => ({
	type: "write",
	path: name,
	content,
	reason: "test",
});
it("commits independent indexed replacements before any file effects", async () => {
	const f = setup(
		[write("a"), write("b")],
		[
			{ index: 0, input: { file_path: "x", content: "X" } },
			{ index: 1, input: { file_path: "y", content: "Y" } },
		],
	);
	await f.run();
	expect(fs.existsSync(path.join(f.cwd, "a"))).toBe(false);
	expect(fs.existsSync(path.join(f.cwd, "b"))).toBe(false);
	expect(fs.readFileSync(path.join(f.cwd, "x"), "utf8")).toBe("X");
	expect(fs.readFileSync(path.join(f.cwd, "y"), "utf8")).toBe("Y");
	expect(f.ctx.invocation!.input).toEqual({
		queries: [write("a"), write("b")],
	});
	expect(f.resolver).toHaveBeenCalledTimes(1);
});
it("refuses original unread files before invoking source permission hooks", async () => {
	const f = setup([write("existing")], [{ index: 0, input: { file_path: "other", content: "new" } }]);
	fs.writeFileSync(path.join(f.cwd, "existing"), "old");
	await expect(f.run()).rejects.toThrow(/not read/);
	expect(f.resolver).not.toHaveBeenCalled();
});
it("an unread replacement in the second query leaves the first untouched", async () => {
	const f = setup([write("a"), write("b")], [{ index: 1, input: { file_path: "existing", content: "new" } }]);
	fs.writeFileSync(path.join(f.cwd, "existing"), "old");
	await expect(f.run()).rejects.toThrow(/not read/);
	expect(fs.existsSync(path.join(f.cwd, "a"))).toBe(false);
	expect(fs.readFileSync(path.join(f.cwd, "existing"), "utf8")).toBe("old");
});
it("retains original approval for an unchanged sibling source ask", async () => {
	const f = setup([write("asked"), write("b")], [{ index: 1, input: { file_path: "c", content: "C" } }]);
	f.permission.setSourcePolicy((invocation) => ({
		decision: (invocation.input as any).queries.some((q: any) => q.path === "asked") ? "ask" : "none",
		message: "asked source",
	}));
	await f.run();
	expect(fs.readFileSync(path.join(f.cwd, "asked"), "utf8")).toBe("original");
	expect(fs.readFileSync(path.join(f.cwd, "c"), "utf8")).toBe("C");
});
it("shows the candidate path when its source ask requires interactive review", async () => {
	const f = setup([write("a")], [{ index: 0, input: { file_path: "candidate", content: "C" } }]);
	f.ctx.hasUI = true;
	f.permission.setSourcePolicy((invocation) => ({
		decision: (invocation.input as any).queries[0].path === "candidate" ? "ask" : "none",
		message: "candidate needs review",
	}));
	const select = vi.fn(async (_title: string) => "Reject all");
	f.ctx.ui.select = select;
	await expect(f.run()).rejects.toThrow();
	expect(select.mock.calls[0]?.[0]).toContain("candidate");
	expect(fs.existsSync(path.join(f.cwd, "candidate"))).toBe(false);
});
it("preserves sequential native queries when hooks return no replacements", async () => {
	const f = setup(
		[
			{
				type: "edit",
				path: "same",
				edits: [{ oldText: "A", newText: "B" }],
				reason: "one",
			},
			{
				type: "edit",
				path: "same",
				edits: [{ oldText: "B", newText: "C" }],
				reason: "two",
			},
		],
		[],
	);
	fs.writeFileSync(path.join(f.cwd, "same"), "A");
	f.guard.record(path.join(f.cwd, "same"));
	f.resolver.mockResolvedValue({ decision: "allow" } as any);
	await f.run();
	expect(fs.readFileSync(path.join(f.cwd, "same"), "utf8")).toBe("C");
});
it("refuses a target symlink changed during original approval before any write", async () => {
	const f = setup([write("alias/new")], []);
	const first = tmp(),
		second = tmp();
	fs.symlinkSync(first, path.join(f.cwd, "alias"));
	f.resolver.mockImplementation(async () => {
		fs.unlinkSync(path.join(f.cwd, "alias"));
		fs.symlinkSync(second, path.join(f.cwd, "alias"));
		return { decision: "allow" } as any;
	});
	await expect(f.run()).rejects.toThrow(/changed|identity/);
	expect(fs.existsSync(path.join(second, "new"))).toBe(false);
});
it("validates all candidate edit spans before an earlier write", async () => {
	const f = setup(
		[
			write("first"),
			{
				type: "edit",
				path: "edit",
				edits: [{ oldText: "AB", newText: "X" }],
				reason: "edit",
			},
		],
		[
			{
				index: 1,
				input: { file_path: "edit", old_string: "AB", new_string: "Y" },
			},
		],
	);
	// An invalid second query supplied by the model must not be retried after the first effect.
	fs.writeFileSync(path.join(f.cwd, "edit"), "NO MATCH");
	f.guard.record(path.join(f.cwd, "edit"));
	await expect(f.run()).rejects.toThrow();
	expect(fs.existsSync(path.join(f.cwd, "first"))).toBe(false);
});
it("refuses overlapping MultiEdit spans before any sibling write", async () => {
	const f = setup(
		[
			write("first"),
			{
				type: "edit",
				path: "edit",
				edits: [
					{ oldText: "A", newText: "a" },
					{ oldText: "D", newText: "d" },
				],
				reason: "edit",
			},
		],
		[
			{
				index: 1,
				input: {
					file_path: "edit",
					edits: [
						{ old_string: "ABC", new_string: "X" },
						{ old_string: "BC", new_string: "Y" },
					],
				},
			},
		],
	);
	fs.writeFileSync(path.join(f.cwd, "edit"), "ABCD");
	f.guard.record(path.join(f.cwd, "edit"));
	await expect(f.run()).rejects.toThrow(/overlap/);
	expect(fs.existsSync(path.join(f.cwd, "first"))).toBe(false);
	expect(fs.readFileSync(path.join(f.cwd, "edit"), "utf8")).toBe("ABCD");
});
it("does not commit when a candidate target changes after preparation", async () => {
	const f = setup([write("original")], [{ index: 0, input: { file_path: "alias/new", content: "new" } }]);
	const first = tmp(),
		second = tmp();
	fs.symlinkSync(first, path.join(f.cwd, "alias"));
	f.refresh
		.mockImplementationOnce(async () => {})
		.mockImplementationOnce(async () => {
			fs.unlinkSync(path.join(f.cwd, "alias"));
			fs.symlinkSync(second, path.join(f.cwd, "alias"));
		});
	await expect(f.run()).rejects.toThrow(/changed/);
	expect(f.params.queries[0].path).toBe("original");
	expect(fs.existsSync(path.join(second, "new"))).toBe(false);
});
it("does not commit when cancelled during final candidate refresh", async () => {
	const f = setup([write("original")], [{ index: 0, input: { file_path: "candidate", content: "new" } }]);
	let active = true;
	f.ctx.invocation = captureToolInvocation("file-one", "file", f.params, () => active);
	f.refresh
		.mockImplementationOnce(async () => {})
		.mockImplementationOnce(async () => {
			active = false;
		});
	await expect(f.run()).rejects.toThrow(/expired|Cancelled/);
	expect(f.params.queries[0].path).toBe("original");
	expect(fs.existsSync(path.join(f.cwd, "candidate"))).toBe(false);
});
it("rechecks refreshed policy for the complete candidate batch", async () => {
	const f = setup(
		[write("unchanged"), write("original")],
		[{ index: 1, input: { file_path: "candidate", content: "new" } }],
	);
	let denied = false;
	f.permission.setSourcePolicy(() => ({
		decision: denied ? "deny" : "none",
		message: "late deny",
	}));
	f.refresh
		.mockImplementationOnce(async () => {})
		.mockImplementationOnce(async () => {
			denied = true;
		});
	await expect(f.run()).rejects.toThrow(/late deny/);
	expect(f.params.queries[1].path).toBe("original");
	expect(fs.existsSync(path.join(f.cwd, "unchanged"))).toBe(false);
});
it("preserves native create then edit with source approval but no replacement", async () => {
	const f = setup(
		[
			write("created", "A"),
			{
				type: "edit",
				path: "created",
				edits: [{ oldText: "A", newText: "B" }],
				reason: "followup",
			},
		],
		[],
	);
	f.resolver.mockResolvedValue({ decision: "allow" } as any);
	await f.run();
	expect(fs.readFileSync(path.join(f.cwd, "created"), "utf8")).toBe("B");
});
