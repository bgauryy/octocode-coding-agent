import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../src/core/features/index.ts";
import { formatFeedback, inspectMutations } from "../../src/octocode/files/feedback/diagnostics.ts";
import { currentMutationRevision, mutationEpoch } from "../../src/octocode/files/feedback/revisions.ts";
import { captureParseBefore, formatParseFeedback, inspectParseAfter } from "../../src/octocode/files/feedback/parse.ts";
import { matchesResponsePath } from "../../src/octocode/files/feedback/path.ts";
import type { MutationReceipt } from "../../src/octocode/files/render.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { sha256 } from "../../../common/src/atomic-file.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
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

it("reads issues from the current server row shape (operation, no status) and the kind-shaped row", async () => {
	// The shape the research server returns today, captured from a live diagnostic call after a type-error edit.
	const current = fixture();
	callable(current.ctx, {
		operation: "diagnostics",
		matches: [
			{
				message: "Type 'string' is not assignable to type 'number'.",
				severity: "error",
				code: 2322,
				source: "ts",
				displayRange: { startLine: 1, startCharacter: 14, endLine: 1 },
			},
		],
		lsp: { serverAvailable: true, provider: "diagnosticProvider", source: "lsp" },
		workspaceRoot: ".",
		path: "source.ts",
	});
	const results = await inspectMutations([current.receipt], current.ctx);
	expect(results).toMatchObject([
		{ state: "issues", issues: ["2322 :1 Type 'string' is not assignable to type 'number'."] },
	]);
	expect(formatFeedback(results)).toContain("diagnostics observed after edit");
	const legacy = fixture();
	callable(legacy.ctx, { kind: "diagnostics", path: "source.ts", matches: [{ message: "Legacy", code: 1 }] });
	expect(await inspectMutations([legacy.receipt], legacy.ctx)).toMatchObject([{ state: "issues" }]);
	const other = fixture();
	callable(other.ctx, { operation: "references", path: "source.ts", matches: [{ message: "not a diagnostic" }] });
	expect(await inspectMutations([other.receipt], other.ctx)).toMatchObject([{ state: "unavailable" }]);
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
	// The Octocode server sends workspace-relative paths without an envelope root; its root is the session cwd.
	expect(matchesResponsePath({ results: [row] }, row, f.file, path.dirname(f.file))).toBe(true);
	expect(matchesResponsePath({ results: [row] }, row, f.file, path.join(path.dirname(f.file), "nested"))).toBe(false);
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

it("says nothing when diagnostics or the parse prove nothing about the edit, and keeps real findings", () => {
	for (const state of [
		"observed-empty",
		"unpublished",
		"unsupported",
		"unavailable",
		"cancelled",
		"pending",
		"superseded",
	] as const)
		expect(formatFeedback([{ path: "a.ts", state }]), state).toBe("");
	for (const state of ["observed-parsed", "unsupported", "superseded"] as const)
		expect(formatParseFeedback([{ path: "a.ts", state }]), state).toBe("");
	expect(
		formatFeedback([
			{ path: "a.ts", state: "observed-empty" },
			{ path: "b.ts", state: "issues", issues: ["TS2322 :1 bad"] },
		]),
	).toBe("b.ts: diagnostics observed after edit (source version unverified): TS2322 :1 bad.");
	expect(formatParseFeedback([{ path: "a.ts", state: "possible-regression" }])).toContain("possible parse regression");
	expect(formatParseFeedback([{ path: "a.ts", state: "already-invalid" }])).toContain("already observed");
});

it("reads the current syntaxTree row, which omits the request's operation, and rejects a different operation", async () => {
	const observe = async (operation: string | undefined, recovered: boolean) => {
		const f = fixture();
		// The live row after a syntax-error edit: no `operation`, no `status`, recovery in diagnostics and partialReasons.
		const data = (flag: boolean) => ({
			...(operation === undefined ? {} : { operation }),
			path: "source.ts",
			nodes: [{ node: "0 program 1:1-2:1" }],
			...(flag
				? {
						isPartial: true,
						terminalLimit: true,
						partialReasons: ["parseRecovered"],
						diagnostics: [{ code: "syntaxTree.parse.recovered", severity: "warning", stage: "parse" }],
					}
				: {}),
		});
		let flag = false;
		Object.defineProperty(f.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
		Object.defineProperty(f.ctx, "executeTool", {
			value: vi.fn(async () => ({
				isError: false,
				result: {
					content: [],
					structuredContent: { results: [{ index: 0, data: data(flag) }], root: path.dirname(f.file) },
				},
			})),
		});
		const before = await captureParseBefore([f.file], f.ctx);
		fs.writeFileSync(f.file, "const x = ;\n");
		flag = recovered;
		return inspectParseAfter([{ ...f.receipt, digest: sha256(fs.readFileSync(f.file)) }], before, f.ctx);
	};
	expect(await observe(undefined, true)).toMatchObject([{ state: "possible-regression" }]);
	expect(formatParseFeedback(await observe(undefined, true))).toContain("possible parse regression");
	expect(await observe("diagnostics", true)).not.toMatchObject([{ state: "possible-regression" }]);
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

it("claims a recovered parse whose walk ends at a terminal limit", async () => {
	// Live finding: a recovered parse always ends the walk at a terminal limit, and the served row still
	// proves the parse; the composed call must also stay within the research tool's query schema.
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
								...(recovered
									? {
											isPartial: true,
											terminalLimit: true,
											partialReasons: ["parseRecovered"],
											diagnostics: [{ code: "syntaxTree.parse.recovered" }],
										}
									: {}),
							},
						},
					],
					root: path.dirname(f.file),
				},
			},
		})),
	});
	const before = await captureParseBefore([f.file], f.ctx);
	expect(before.get(f.file)?.state).toBe("parsed");
	fs.writeFileSync(f.file, "const x = ;\n");
	recovered = true;
	expect((await captureParseBefore([f.file], f.ctx)).get(f.file)?.state).toBe("recovered");
	const receipt = { ...f.receipt, digest: sha256(fs.readFileSync(f.file)) };
	expect(await inspectParseAfter([receipt], before, f.ctx)).toMatchObject([{ state: "possible-regression" }]);
	expect(f.ctx.executeTool).toHaveBeenCalledWith(
		"mcp__octocode__astSearch",
		{ queries: [{ operation: "syntaxTree", path: f.file }] },
		expect.anything(),
	);
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

it("keeps cancellation from claiming a clean result and waits for the server rather than cutting it off", async () => {
	const f = fixture();
	callable(f.ctx, { kind: "diagnostics", matches: [] });
	const controller = new AbortController();
	controller.abort();
	expect(await inspectMutations([f.receipt], f.ctx, controller.signal)).toMatchObject([{ state: "cancelled" }]);
	// A slow server answers in its own time (bounded by the MCP request timeout, not a deadline of this tool).
	const slow = fixture();
	Object.defineProperty(slow.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
	Object.defineProperty(slow.ctx, "executeTool", {
		value: (_tool: string, _args: unknown, options: { signal?: AbortSignal }) =>
			new Promise((resolve) =>
				setTimeout(() => {
					expect(options.signal).toBeUndefined();
					resolve({
						isError: false,
						result: {
							content: [],
							structuredContent: {
								root: slow.ctx.cwd,
								results: [{ data: { path: "source.ts", operation: "syntaxTree", nodes: [] } }],
							},
						},
					});
				}, 30),
			),
	});
	expect((await captureParseBefore([slow.file], slow.ctx)).get(slow.file)?.state).toBe("parsed");
});

it("asks the server once about a file type it does not serve, then skips that type", async () => {
	const f = fixture();
	const doc = path.join(path.dirname(f.file), "notes.md");
	const other = path.join(path.dirname(f.file), "more.md");
	fs.writeFileSync(doc, "# notes\n");
	fs.writeFileSync(other, "# more\n");
	Object.defineProperty(f.ctx, "tools", {
		value: [{ name: "mcp__octocode__astSearch" }, { name: "mcp__octocode__lspSearch" }],
	});
	const executeTool = vi.fn(async (tool: string, args: { queries: [{ path: string }] }) => ({
		isError: true,
		result: {
			content: [
				{
					type: "text",
					text: !args.queries[0].path.endsWith(".md")
						? "Request timed out"
						: tool === "mcp__octocode__astSearch"
							? "No registered tree-sitter grammar for .md files"
							: JSON.stringify({
									results: [
										{ errorCode: "serverUnavailable", error: "No language server is configured for this file." },
									],
								}),
				},
			],
		},
	}));
	Object.defineProperty(f.ctx, "executeTool", { value: executeTool });
	expect((await captureParseBefore([doc], f.ctx)).get(doc)?.state).toBe("unsupported");
	expect((await captureParseBefore([other], f.ctx)).get(other)?.state).toBe("unsupported");
	const receipts = [doc, other].map((file) => ({
		...f.receipt,
		canonicalPath: file,
		digest: sha256(fs.readFileSync(file)),
		beforeDigest: sha256(fs.readFileSync(file)),
	}));
	expect(await inspectMutations(receipts, f.ctx)).toMatchObject([{ state: "unavailable" }, { state: "unsupported" }]);
	// One parse question and one diagnostics question for the whole type; a source file is still asked about.
	expect(executeTool.mock.calls.map(([tool]) => tool)).toEqual([
		"mcp__octocode__astSearch",
		"mcp__octocode__lspSearch",
	]);
	await captureParseBefore([f.file], f.ctx);
	expect(executeTool).toHaveBeenCalledTimes(3);
	// Neither answer is worth a line to the model.
	expect(
		formatFeedback([
			{ path: doc, state: "unavailable" },
			{ path: other, state: "unsupported" },
		]),
	).toBe("");
	expect(formatParseFeedback([{ path: doc, state: "unsupported" }])).toBe("");
});

it("does not ask again in a later session about a file type the server refused", async () => {
	const f = fixture();
	const doc = path.join(path.dirname(f.file), "guide.adoc");
	fs.writeFileSync(doc, "= guide\n");
	Object.defineProperty(f.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
	const executeTool = vi.fn(async () => ({
		isError: true,
		result: { content: [{ type: "text", text: "No registered tree-sitter grammar for .adoc files" }] },
	}));
	Object.defineProperty(f.ctx, "executeTool", { value: executeTool });
	let sessionId = "first-session";
	Object.defineProperty(f.ctx.sessionManager, "getSessionId", { value: () => sessionId });
	expect((await captureParseBefore([doc], f.ctx)).get(doc)?.state).toBe("unsupported");
	sessionId = "second-session";
	expect((await captureParseBefore([doc], f.ctx)).get(doc)?.state).toBe("unsupported");
	// The server's grammars do not change with the session: one question per type for the process.
	expect(executeTool).toHaveBeenCalledTimes(1);
});

it("records only committed queries and inspects the final repeated write", async () => {
	const f = fixture();
	const guard = new FileGuard();
	guard.record(f.file);
	const fake = fakeHost();
	registerFileTool(fake.api, guard, fakePermission(), undefined, undefined, { enabled: true });
	callable(f.ctx, { path: "source.ts", kind: "empty", category: "noDiagnostics", status: "empty" });
	const before = currentMutationRevision(f.ctx.sessionManager.getSessionId());
	const result = await fake.tools.get("file")!.execute(
		"batch",
		{
			queries: [
				{ type: "write", path: f.file, reason: "first", content: "const x = 2;\n" },
				{ type: "write", path: f.file, reason: "second", content: "const x = 3;\n" },
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
	expect(result.content[0].text).not.toContain("diagnostics");
});

it("checks the parse of each file a batch edits, however many times it edits the first", async () => {
	const f = fixture();
	const other = path.join(path.dirname(f.file), "other.ts");
	fs.writeFileSync(other, "const y = 1;\n");
	const guard = new FileGuard();
	guard.record(f.file);
	guard.record(other);
	const fake = fakeHost();
	registerFileTool(fake.api, guard, fakePermission(), undefined, undefined, { enabled: true });
	Object.defineProperty(f.ctx, "tools", { value: [{ name: "mcp__octocode__astSearch" }] });
	Object.defineProperty(f.ctx, "executeTool", {
		value: vi.fn(async (_tool: string, args: { queries: [{ path: string }] }) => {
			const target = args.queries[0].path;
			const recovered = fs.readFileSync(target, "utf8").includes("= ;");
			return {
				isError: false,
				result: {
					content: [],
					structuredContent: {
						root: f.ctx.cwd,
						results: [
							{
								data: {
									path: path.basename(target),
									operation: "syntaxTree",
									nodes: [],
									...(recovered ? { diagnostics: [{ code: "syntaxTree.parse.recovered" }] } : {}),
								},
							},
						],
					},
				},
			};
		}),
	});
	const result = await fake.tools.get("file")!.execute(
		"batch",
		{
			queries: [
				{ type: "write", path: f.file, reason: "one", content: "const x = 2;\n" },
				{ type: "write", path: f.file, reason: "two", content: "const x = 3;\n" },
				{ type: "write", path: f.file, reason: "three", content: "const x = 4;\n" },
				{ type: "write", path: other, reason: "break", content: "const y = ;\n" },
			],
		},
		undefined,
		undefined,
		f.ctx,
	);
	expect(result.content[0].text).toContain(`${other}: possible parse regression observed after edit`);
});
