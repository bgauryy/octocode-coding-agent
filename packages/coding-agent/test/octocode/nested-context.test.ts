import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	NESTED_CONTEXT_DETAILS,
	NESTED_CONTEXT_MAX_BYTES,
	registerNestedContext,
} from "../../src/octocode/files/nested-context.ts";
import { tmp } from "./helpers.ts";

type Result = { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> } | undefined;
type Handler = (event: unknown, ctx: unknown) => Promise<Result>;

/** A repository with a nested package that has its own AGENTS.md, and the registered hook driven like the runner does. */
function setup(options: { trusted?: boolean } = {}) {
	const root = fs.realpathSync(tmp());
	fs.writeFileSync(path.join(root, "AGENTS.md"), "ROOT_RULES");
	const pkg = path.join(root, "packages", "a");
	fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
	fs.writeFileSync(path.join(pkg, "AGENTS.md"), "PACKAGE_A_RULES");
	fs.writeFileSync(path.join(pkg, "src", "x.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(pkg, "src", "y.ts"), "export const y = 2;\n");
	fs.writeFileSync(path.join(root, "top.ts"), "top\n");
	let handler: Handler | undefined;
	registerNestedContext({
		on: (event: string, registered: Handler) => {
			if (event === "tool_result") handler = registered;
		},
	} as never);
	const branch: Array<Record<string, unknown>> = [];
	const ctx = {
		cwd: root,
		isProjectTrusted: () => options.trusted ?? true,
		sessionManager: { getBranch: () => branch },
	};
	/** Runs the hook on a result and keeps it on the branch, as the session would. */
	const run = async (event: Record<string, unknown>): Promise<Result> => {
		const full = { isError: false, content: [{ type: "text", text: "OUTPUT" }], details: undefined, ...event };
		const result = await handler!(full, ctx);
		branch.push({
			type: "message",
			message: { role: "toolResult", details: result?.details ?? full.details },
		});
		return result;
	};
	const bashCat = (file: string) => run({ toolName: "bash", input: { command: `cat ${file}` } });
	const text = (result: Result) => (result?.content ?? []).map((part) => part.text ?? "").join("\n");
	return { root, pkg, branch, run, bashCat, text };
}

describe("nested AGENTS.md on read", () => {
	it("appends a folder's AGENTS.md to the first read under it, once, after the tool's own output", async () => {
		const { pkg, bashCat, text } = setup();
		const first = await bashCat(path.join(pkg, "src", "x.ts"));
		expect(first?.content[0]).toEqual({ type: "text", text: "OUTPUT" });
		expect(text(first)).toContain(
			`<project_instructions path="${path.join(pkg, "AGENTS.md")}">\nPACKAGE_A_RULES\n</project_instructions>`,
		);
		// The working folder's own AGENTS.md is already in the system prompt.
		expect(text(first)).not.toContain("ROOT_RULES");
		expect(first?.details?.[NESTED_CONTEXT_DETAILS]).toEqual([
			{ path: path.join(pkg, "AGENTS.md"), bytes: "PACKAGE_A_RULES".length },
		]);
		expect(await bashCat(path.join(pkg, "src", "y.ts"))).toBeUndefined();
	});

	it("credits reads from any reader's receipts, not a tool name", async () => {
		const { pkg, run, text } = setup();
		const file = path.join(pkg, "src", "x.ts");
		const result = await run({
			toolName: "mcp__any__reader",
			input: {},
			details: { localReads: [{ file, sha256: "a".repeat(64), size: 20, whole: true }] },
		});
		expect(text(result)).toContain("PACKAGE_A_RULES");
		// The receipts stay beside the new key.
		expect(result?.details?.localReads).toHaveLength(1);
	});

	it("adds nothing for files outside a nested folder, errors, nested calls or an untrusted project", async () => {
		const plain = setup();
		expect(await plain.bashCat(path.join(plain.root, "top.ts"))).toBeUndefined();
		const file = path.join(plain.pkg, "src", "x.ts");
		expect(await plain.run({ toolName: "bash", input: { command: `cat ${file}` }, isError: true })).toBeUndefined();
		expect(
			await plain.run({ toolName: "bash", input: { command: `cat ${file}` }, parentToolCallId: "p" }),
		).toBeUndefined();
		const untrusted = setup({ trusted: false });
		expect(await untrusted.bashCat(path.join(untrusted.pkg, "src", "x.ts"))).toBeUndefined();
	});

	it("delivers again after a compaction drops the result that carried it", async () => {
		const { pkg, branch, bashCat, text } = setup();
		await bashCat(path.join(pkg, "src", "x.ts"));
		branch.push({ type: "compaction" });
		expect(text(await bashCat(path.join(pkg, "src", "y.ts")))).toContain("PACKAGE_A_RULES");
	});

	it("never sends instruction files from dependency or version-control folders", async () => {
		const { root, bashCat } = setup();
		for (const dir of ["node_modules/pkg", "vendor/lib", "packages/b/node_modules/dep/src"]) {
			const folder = path.join(root, ...dir.split("/"));
			fs.mkdirSync(folder, { recursive: true });
			fs.writeFileSync(path.join(folder, "AGENTS.md"), "THIRD_PARTY");
			fs.writeFileSync(path.join(folder, "x.js"), "x\n");
			expect(await bashCat(path.join(folder, "x.js"))).toBeUndefined();
		}
	});

	it("does not resend a file whose result a compaction kept, and resends one whose result was cleared", async () => {
		const { pkg, branch, bashCat } = setup();
		await bashCat(path.join(pkg, "src", "x.ts"));
		branch[branch.length - 1].id = "kept";
		branch.push({ type: "compaction", firstKeptEntryId: "kept" });
		expect(await bashCat(path.join(pkg, "src", "y.ts"))).toBeUndefined();

		const cleared = setup();
		await cleared.bashCat(path.join(cleared.pkg, "src", "x.ts"));
		(cleared.branch[cleared.branch.length - 1].message as Record<string, unknown>).toolCallId = "call-1";
		cleared.branch.push({
			type: "custom",
			customType: "octocode-cleared-results",
			data: { results: [{ id: "call-1", saved: "/tmp/saved.txt" }] },
		});
		expect(cleared.text(await cleared.bashCat(path.join(cleared.pkg, "src", "y.ts")))).toContain("PACKAGE_A_RULES");
	});

	it("holds at most the byte budget of nested instructions in context", async () => {
		const { root, bashCat, text } = setup();
		const big = "r".repeat(NESTED_CONTEXT_MAX_BYTES - 10);
		for (const name of ["b", "c"]) {
			fs.mkdirSync(path.join(root, name), { recursive: true });
			fs.writeFileSync(path.join(root, name, "AGENTS.md"), `${name.toUpperCase()}${big}`);
			fs.writeFileSync(path.join(root, name, "f.ts"), "f\n");
		}
		expect(text(await bashCat(path.join(root, "b", "f.ts")))).toContain("Brrr");
		expect(await bashCat(path.join(root, "c", "f.ts"))).toBeUndefined();
	});
});
