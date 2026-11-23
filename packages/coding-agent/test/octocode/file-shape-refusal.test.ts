import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { Params, renameReasoning } from "../../src/octocode/files/tool/queries.ts";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { asSetup, fakeCtx, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const change = { type: "edit", path: "/work/a.ts", edits: [{ oldText: "a", newText: "b" }] };

/** The corrected call the refusal echoes, read back from its text. */
function echoed(error: unknown): unknown {
	const text = (error as Error).message;
	return JSON.parse(text.slice(text.indexOf("Corrected call:\n") + "Corrected call:\n".length));
}

describe("file tool: refusal for a call with both or neither of queries and patch", () => {
	it("refuses both fields and echoes the corrected call with queries kept and patch dropped", () => {
		let thrown: unknown;
		try {
			renameReasoning({ reason: "Fix a", queries: [{ ...change, reason: "Fix a" }], patch: "*** Begin Patch" });
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toMatch(/not both\. Send one\. Corrected call:/);
		expect(echoed(thrown)).toEqual({ reason: "Fix a", queries: [{ ...change, reason: "Fix a" }] });
	});

	it("echoes a change with a path but no type as queries, and names the missing shape", () => {
		let thrown: unknown;
		try {
			renameReasoning({ reason: "Fix a", path: "/work/a.ts" });
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toMatch(/had neither\. Wrap the change as queries/);
		expect(echoed(thrown)).toEqual({ reason: "Fix a", queries: [{ path: "/work/a.ts" }] });
	});

	it("reads parameters a model wrote as text inside reason back into the corrected call", () => {
		// The shape a model produced: path and edits as fields, type only as text in `reason`.
		let thrown: unknown;
		try {
			renameReasoning({
				reason: 'Correct the citation.</reason>\n<parameter name="type">edit',
				path: "/work/a.ts",
				edits: [{ oldText: "a", newText: "b" }],
			});
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toMatch(/parameters were written as text inside `reason`/);
		expect(echoed(thrown)).toEqual({ reason: "Correct the citation.", queries: [change] });
	});

	it("reads a queries array written as text inside reason", () => {
		let thrown: unknown;
		try {
			renameReasoning({
				reason: `Fix a.</reason>\n<parameter name="queries">${JSON.stringify([change])}`,
			});
		} catch (error) {
			thrown = error;
		}
		expect(echoed(thrown)).toEqual({ reason: "Fix a.", queries: [change] });
	});

	it("reads a flat edit's op and oldText/newText into a corrected call that applies as sent", async () => {
		// A small model's first guess, verbatim from a cold interview: one edit's fields at the top level, `op` for `type`.
		const naive = {
			reason: "Change a + b to a + b + 0",
			path: "index.ts",
			op: "edit",
			oldText: "a + b",
			newText: "a + b + 0",
		};
		let thrown: unknown;
		try {
			renameReasoning(naive);
		} catch (error) {
			thrown = error;
		}
		const corrected = echoed(thrown) as Record<string, unknown>;
		expect(corrected).toEqual({
			reason: naive.reason,
			queries: [{ type: "edit", path: "index.ts", edits: [{ oldText: "a + b", newText: "a + b + 0" }] }],
		});
		// Copying the corrected call back passes the declared schema and the tool, and makes the edit.
		const valid = validateToolArguments(
			{ name: "file", description: "", parameters: Params },
			{ type: "toolCall", id: "c", name: "file", arguments: corrected as JsonObject },
		);
		let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		registerFileTool(
			asSetup({ registerTool: (registered: typeof tool) => (tool = registered), on: () => undefined }) as never,
			new FileGuard(),
			fakePermission(),
		);
		const cwd = tmp();
		fs.writeFileSync(path.join(cwd, "index.ts"), "export const add = (a: number, b: number) => a + b;\n");
		await tool!.execute("c", renameReasoning(valid), undefined, undefined, fakeCtx({ cwd, hasUI: false }));
		expect(fs.readFileSync(path.join(cwd, "index.ts"), "utf8")).toBe(
			"export const add = (a: number, b: number) => a + b + 0;\n",
		);
	});

	it("names an edit for a top-level oldText/newText pair without op or type", () => {
		let thrown: unknown;
		try {
			renameReasoning({ reason: "Fix a", path: "/work/a.ts", oldText: "a", newText: "b" });
		} catch (error) {
			thrown = error;
		}
		expect(echoed(thrown)).toEqual({ reason: "Fix a", queries: [change] });
	});

	it("still accepts the valid forms", () => {
		expect(() => renameReasoning({ reason: "Fix a", queries: [change] })).not.toThrow();
		expect(() => renameReasoning({ patch: "*** Begin Patch\n*** End Patch" })).not.toThrow();
	});
});
