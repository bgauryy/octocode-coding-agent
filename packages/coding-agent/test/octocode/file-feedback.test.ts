import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/index.ts";
import { formatFeedback, inspectMutations } from "../../src/octocode/files/feedback/diagnostics.ts";
import { currentMutationRevision, mutationEpoch } from "../../src/octocode/files/feedback/revisions.ts";
import { captureParseBefore, inspectParseAfter } from "../../src/octocode/files/feedback/parse.ts";
import { matchesResponsePath } from "../../src/octocode/files/feedback/path.ts";
import type { MutationReceipt } from "../../src/octocode/files/render.ts";
import { FileGuard, registerFileTool } from "../../src/octocode/files/tool.ts";
import { sha256 } from "../../src/octocode/shared/atomic.ts";
import { fakeCtx, fakePermission, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

function fixture() {
	const cwd = fs.realpathSync(tmp());
	const file = path.join(cwd, "source.ts");
	fs.writeFileSync(file, "const x = 1;\n");
	const ctx = fakeCtx({ cwd }) as unknown as ExtensionToolContext;
	const receipt: MutationReceipt = {
		canonicalPath: file,
		toolCallId: "edit-one",
		operation: "edit",
		digest: sha256(fs.readFileSync(file)),
		beforeDigest: sha256(fs.readFileSync(file)),
		sessionId: ctx.sessionManager.getSessionId(),
		epoch: mutationEpoch,
		revision: 1,
	};
	return { file, ctx, receipt };
}

function callable(ctx: ExtensionToolContext, row: unknown, change?: () => void) {
	Object.defineProperty(ctx, "tools", { value: [{ name: "mcp__octocode__lspSearch" }] });
	Object.defineProperty(ctx, "executeTool", {
		value: vi.fn(async () => {
			change?.();
			return {
				isError: false,
				result: {
					content: [],
					structuredContent: { root: ctx.cwd, results: [{ data: row, status: (row as { status?: string }).status }] },
				},
			};
		}),
	});
}

it("coalesces repeated commits and distinguishes published empty from unpublished diagnostics", async () => {
	const f = fixture();
	callable(f.ctx, { path: "source.ts", kind: "empty", category: "noDiagnostics", status: "empty" });
	const results = await inspectMutations([f.receipt, { ...f.receipt, revision: 2 }], f.ctx);
	expect(results).toEqual([{ path: f.file, state: "observed-empty" }]);
	expect(f.ctx.executeTool).toHaveBeenCalledTimes(1);
	expect(f.ctx.executeTool).toHaveBeenCalledWith(
		"mcp__octocode__lspSearch",
		expect.objectContaining({ queries: [expect.objectContaining({ operation: "diagnostic", path: f.file })] }),
		expect.anything(),
	);
	const unpublished = fixture();
	callable(unpublished.ctx, {
		path: "source.ts",
		lsp: { serverAvailable: true },
		isPartial: true,
		partialReasons: ["diagnosticsNotPublished"],
		matches: [],
	});
	expect(await inspectMutations([unpublished.receipt], unpublished.ctx)).toMatchObject([{ state: "unpublished" }]);
	const wrong = fixture();
	callable(wrong.ctx, { kind: "diagnostics", path: "/another/source.ts", matches: [], lsp: { serverAvailable: true } });
	expect(await inspectMutations([wrong.receipt], wrong.ctx)).toMatchObject([{ state: "unavailable" }]);
});

it("resolves native workspace-relative row paths against the response root", () => {
	const f = fixture();
	const row = { data: { operation: "syntaxTree", path: "source.ts", snapshot: "s", nodes: [] } };
	expect(matchesResponsePath({ root: path.dirname(f.file), results: [row] }, row, f.file)).toBe(true);
	expect(matchesResponsePath({ base: path.dirname(f.file), results: [row] }, row, f.file)).toBe(true);
	expect(
		matchesResponsePath(
			{ root: path.dirname(f.file), results: [row] },
			row,
			path.join(path.dirname(f.file), "other.ts"),
		),
	).toBe(false);
	expect(matchesResponsePath({ results: [row] }, row, f.file)).toBe(false);
	expect(
		matchesResponsePath(
			{ root: path.dirname(f.file), results: [{ data: { nodes: [] } }] },
			{ data: { nodes: [] } },
			f.file,
		),
	).toBe(false);
});

it("does not attach a pathless research row to a committed mutation", async () => {
	const f = fixture();
	callable(f.ctx, { kind: "empty", category: "noDiagnostics", status: "empty" });
	expect(await inspectMutations([f.receipt], f.ctx)).toMatchObject([{ state: "unavailable" }]);
	const parser = fixture();
	Object.defineProperty(parser.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
	Object.defineProperty(parser.ctx, "executeTool", {
		value: async () => ({
			isError: false,
			result: {
				content: [],
				structuredContent: { root: parser.ctx.cwd, results: [{ data: { operation: "syntaxTree", nodes: [] } }] },
			},
		}),
	});
	expect((await captureParseBefore([parser.file], parser.ctx)).get(parser.file)?.state).toBe("unsupported");
});

it("does not claim a completed parse from failed or incomplete syntax-tree rows", async () => {
	for (const extra of [
		{ status: "error" },
		{ data: { isPartial: true } },
		{ data: { partialReasons: ["outputLimit"] } },
		{ data: { terminalLimit: true } },
	]) {
		const f = fixture();
		Object.defineProperty(f.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
		Object.defineProperty(f.ctx, "executeTool", {
			value: async () => ({
				isError: false,
				result: {
					content: [],
					structuredContent: {
						root: f.ctx.cwd,
						results: [
							{
								...("status" in extra ? { status: extra.status } : {}),
								data: { path: "source.ts", operation: "syntaxTree", nodes: [], ...("data" in extra ? extra.data : {}) },
							},
						],
					},
				},
			}),
		});
		expect((await captureParseBefore([f.file], f.ctx)).get(f.file)?.state).toBe("unsupported");
	}
	const recovered = fixture();
	Object.defineProperty(recovered.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
	Object.defineProperty(recovered.ctx, "executeTool", {
		value: async () => ({
			isError: false,
			result: {
				content: [],
				structuredContent: {
					root: recovered.ctx.cwd,
					results: [
						{
							data: {
								path: "source.ts",
								operation: "syntaxTree",
								nodes: [],
								isPartial: true,
								partialReasons: ["parseRecovered"],
							},
						},
					],
				},
			},
		}),
	});
	expect((await captureParseBefore([recovered.file], recovered.ctx)).get(recovered.file)?.state).toBe("recovered");
});

it("discards parser observations from a session switched during the nested call", async () => {
	const f = fixture();
	let sessionId = "before";
	Object.defineProperty(f.ctx.sessionManager, "getSessionId", { value: () => sessionId });
	Object.defineProperty(f.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
	Object.defineProperty(f.ctx, "executeTool", {
		value: async () => {
			sessionId = "after";
			return {
				isError: false,
				result: {
					content: [],
					structuredContent: {
						root: f.ctx.cwd,
						results: [{ data: { path: "source.ts", operation: "syntaxTree", nodes: [] } }],
					},
				},
			};
		},
	});
	expect((await captureParseBefore([f.file], f.ctx)).has(f.file)).toBe(false);
});

it("labels issue diagnostics as unverified against committed bytes", () => {
	expect(formatFeedback([{ path: "a.ts", state: "issues", issues: ["TS2307 :8 module missing"] }])).toContain(
		"source version unverified",
	);
});

it("flags a possible parser regression only from a clean before observation and recovered after observation", async () => {
	const f = fixture();
	let recovered = false;
	Object.defineProperty(f.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
	Object.defineProperty(f.ctx, "executeTool", {
		value: vi.fn(async () => ({
			isError: false,
			result: {
				content: [],
				structuredContent: {
					results: [
						{
							data: {
								operation: "syntaxTree",
								path: "source.ts",
								nodes: [],
								...(recovered ? { diagnostics: [{ code: "syntaxTree.parse.recovered" }] } : {}),
							},
						},
					],
					root: path.dirname(f.file),
				},
			},
		})),
	});
	const before = await captureParseBefore([f.file], f.ctx);
	fs.writeFileSync(f.file, "const x = ;\n");
	recovered = true;
	const receipt = { ...f.receipt, digest: sha256(fs.readFileSync(f.file)) };
	expect(await inspectParseAfter([receipt], before, f.ctx)).toMatchObject([{ state: "possible-regression" }]);
	const alreadyInvalid = await captureParseBefore([f.file], f.ctx);
	expect(await inspectParseAfter([{ ...receipt, beforeDigest: receipt.digest }], alreadyInvalid, f.ctx)).toMatchObject([
		{ state: "already-invalid" },
	]);
	fs.writeFileSync(f.file, "peer edited\n");
	expect(await inspectParseAfter([receipt], before, f.ctx)).toMatchObject([{ state: "superseded" }]);
});

it("suppresses old observations after a competing disk edit and avoids an uncallable tool", async () => {
	const f = fixture();
	callable(f.ctx, { kind: "diagnostics", matches: [] }, () => {
		fs.writeFileSync(f.file, "peer changed it\n");
	});
	expect(await inspectMutations([f.receipt], f.ctx)).toMatchObject([{ state: "superseded" }]);
	const unavailable = fixture();
	Object.defineProperty(unavailable.ctx, "tools", { value: [] });
	expect(await inspectMutations([unavailable.receipt], unavailable.ctx)).toMatchObject([{ state: "unavailable" }]);
});

it("keeps cancellation and a bounded parser timeout from claiming a clean result", async () => {
	const f = fixture();
	callable(f.ctx, { kind: "diagnostics", matches: [] });
	const controller = new AbortController();
	controller.abort();
	expect(await inspectMutations([f.receipt], f.ctx, controller.signal)).toMatchObject([{ state: "cancelled" }]);
	const stalled = fixture();
	Object.defineProperty(stalled.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
	Object.defineProperty(stalled.ctx, "executeTool", { value: () => new Promise(() => undefined) });
	const started = Date.now();
	const before = await captureParseBefore([stalled.file], stalled.ctx);
	expect(before.get(stalled.file)?.state).toBe("unsupported");
	expect(Date.now() - started).toBeLessThan(2000);
});

it("records only committed queries and inspects the final repeated write", async () => {
	const f = fixture();
	const guard = new FileGuard();
	guard.record(f.file);
	const fake = fakePi();
	registerFileTool(fake.pi, guard, fakePermission(), undefined, undefined, { enabled: true });
	callable(f.ctx, { path: "source.ts", kind: "empty", category: "noDiagnostics", status: "empty" });
	const before = currentMutationRevision(f.ctx.sessionManager.getSessionId());
	const result = await fake.tools.get("file")!.execute(
		"batch",
		{
			queries: [
				{ type: "write", path: f.file, reasoning: "first", content: "const x = 2;\n" },
				{ type: "write", path: f.file, reasoning: "second", content: "const x = 3;\n" },
			],
		},
		undefined,
		undefined,
		f.ctx,
	);
	expect(result.details.receipts).toHaveLength(2);
	expect(result.details.receipts.map((receipt: MutationReceipt) => receipt.revision)).toEqual([before + 1, before + 2]);
	expect(result.details.diagnostics).toMatchObject([{ state: "observed-empty" }]);
	expect(f.ctx.executeTool).toHaveBeenCalledTimes(1);
	expect(result.content[0].text).toContain("source version unverified");
});
