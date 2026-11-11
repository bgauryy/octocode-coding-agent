import fs from "node:fs";
import path from "node:path";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { fakeCtx, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

interface FileTool {
	name: string;
	parameters: never;
	prepareArguments: (args: unknown) => unknown;
	execute: (...args: unknown[]) => Promise<{ details: { outcomes: { ok: boolean }[] } }>;
}

function fileTool(): FileTool {
	let tool: FileTool | undefined;
	registerFileTool(
		{
			registerTool: (t: FileTool) => {
				tool = t;
			},
			on: () => undefined,
		} as never,
		new FileGuard(),
		fakePermission(),
	);
	return tool!;
}

/** The agent loop's order: prepare the model's arguments, validate them against the schema, then execute. */
async function call(tool: FileTool, args: Record<string, unknown>, cwd: string) {
	const prepared = tool.prepareArguments(args) as Record<string, unknown>;
	const validated = validateToolArguments(
		tool as never,
		{
			type: "toolCall",
			id: "c",
			name: "file",
			arguments: prepared,
		} as never,
	);
	return tool.execute("c", validated, undefined, undefined, fakeCtx({ cwd, hasUI: false }));
}

describe("file tool: a single flat change", () => {
	it("runs a call that is one change itself, as the one-item queries it means", async () => {
		const cwd = tmp();
		const result = await call(
			fileTool(),
			{ type: "write", path: "a.txt", content: "x", reasoning: "Create the file" },
			cwd,
		);
		expect(result.details.outcomes).toMatchObject([{ ok: true }]);
		expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("x");
	});

	it("takes the call's reason from its changes when every change has one, and still requires one otherwise", async () => {
		const cwd = tmp();
		const tool = fileTool();
		const result = await call(
			tool,
			{
				queries: [
					{ type: "write", path: "a.txt", content: "a", reason: "Add a" },
					{ type: "write", path: "b.txt", content: "b", reasoning: "Add b" },
				],
			},
			cwd,
		);
		expect(result.details.outcomes).toMatchObject([{ ok: true }, { ok: true }]);
		expect(tool.prepareArguments({ queries: [{ type: "delete", path: "a", reason: "x" }] })).toMatchObject({
			reason: "x",
		});
		await expect(
			call(
				tool,
				{
					queries: [
						{ type: "write", path: "c.txt", content: "c", reason: "Add c" },
						{ type: "write", path: "d.txt", content: "d" },
					],
				},
				cwd,
			),
		).rejects.toThrow(/reason/);
		expect(fs.existsSync(path.join(cwd, "c.txt"))).toBe(false);
	});

	it("keeps the call's reason on the wrapped change", () => {
		const prepared = fileTool().prepareArguments({ reason: "r", type: "delete", path: "b.txt" }) as {
			reason: string;
			queries: { reason: string; type: string; path: string }[];
		};
		expect(prepared.queries).toEqual([{ reason: "r", type: "delete", path: "b.txt" }]);
	});

	it("still refuses what is not unambiguously one change, naming the expected shape", async () => {
		const cwd = tmp();
		const tool = fileTool();
		const taught = /file takes either queries .* or patch .*not both/;
		// An unknown change type and a missing path are left as sent. A change beside a patch is the patch's call: the
		// change fields are not wrapped, so nothing is written, and an empty patch is an error.
		await expect(call(tool, { reason: "r", type: "copy", path: "a.txt" }, cwd)).rejects.toThrow(taught);
		await expect(call(tool, { reason: "r", type: "write", content: "x" }, cwd)).rejects.toThrow(taught);
		await expect(
			call(tool, { reason: "r", type: "write", path: "a.txt", patch: "*** Begin Patch\n*** End Patch" }, cwd),
		).rejects.toThrow(/Empty patch: it changes no file/);
		expect(fs.existsSync(path.join(cwd, "a.txt"))).toBe(false);
	});
});

describe("file tool guidance and result text", () => {
	it("tells the model to split a very large write, and adds no empty diagnostics line to a result", async () => {
		const tool = fileTool() as FileTool & { promptGuidelines: string[] };
		expect(tool.promptGuidelines.join("\n")).toMatch(/cut off by the output limit[^]*write a very large file in parts/);
		const cwd = fs.realpathSync(tmp());
		const result = (await call(tool, { reason: "r", type: "write", path: "a.txt", content: "x" }, cwd)) as unknown as {
			content: { text: string }[];
		};
		// A written file is known whole, so the line ends with the digest a following anchored edit names.
		expect(result.content[0].text).toBe(
			"1. OK write a.txt: wrote sourceSha256=2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
		);
	});
});
