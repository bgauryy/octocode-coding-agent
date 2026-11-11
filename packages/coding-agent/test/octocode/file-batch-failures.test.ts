import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addFileToolOps } from "../../src/octocode/compaction/register.ts";
import { Checkpoints } from "../../src/octocode/files/checkpoint.ts";
import { appliedFileOutcomes, seenFiles } from "../../src/octocode/files/reads.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { batchText } from "../../src/octocode/files/tool/queries.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** RFC 2026-11-11 core tools, step F1: a batch in which any query failed is an error result that starts "k of n failed". */
function setup() {
	const cwd = fs.realpathSync(tmp());
	const names = ["a.txt", "b.txt", "c.txt"];
	const guard = new FileGuard();
	for (const name of names) {
		fs.writeFileSync(path.join(cwd, name), `${name} one\n`);
		guard.record(path.join(cwd, name));
	}
	const checkpoints = new Checkpoints();
	checkpoints.open(tmp());
	checkpoints.beginTurn();
	const fake = fakeHost();
	registerFileTool(fake.api, guard, fakePermission(), checkpoints);
	const edit = (name: string, oldText: string) => ({
		type: "edit",
		path: name,
		reason: "test",
		edits: [{ oldText, newText: "two" }],
	});
	const run = (queries: unknown[]) =>
		fake.tools.get("file")!.execute("batch", { queries }, undefined, undefined, fakeCtx({ cwd }));
	const patch = (text: string) =>
		fake.tools.get("file")!.execute("patch", { patch: text, reason: "test" }, undefined, undefined, fakeCtx({ cwd }));
	return { cwd, edit, run, patch };
}

describe("an empty patch (RFC core-tools F3)", () => {
	it("is an error that says what a patch needs, not a success that changed nothing", async () => {
		const f = setup();
		await expect(f.patch("*** Begin Patch\n*** End Patch")).rejects.toThrow(
			/^Empty patch: it changes no file\. Put at least one `\*\*\* Add File:`/,
		);
	});

	it("still applies a patch that names a file", async () => {
		const f = setup();
		const result = await f.patch("*** Begin Patch\n*** Add File: new.txt\n+hello\n*** End Patch");
		expect(result.isError).toBeUndefined();
		expect(fs.readFileSync(path.join(f.cwd, "new.txt"), "utf8")).toBe("hello\n");
	});
});

describe("a file batch with a failed query", () => {
	it("is an error result that starts with the count, and still applies and reports the others (V10)", async () => {
		const f = setup();
		const result = await f.run([f.edit("a.txt", "one"), f.edit("b.txt", "missing"), f.edit("c.txt", "one")]);
		expect(result.isError).toBe(true);
		const text = result.content[0].text as string;
		expect(text).toMatch(/^1 of 3 failed\n1\. OK edit a\.txt/);
		expect(text).toMatch(/\n2\. FAILED edit b\.txt: /);
		expect(text).toMatch(/\n3\. OK edit c\.txt/);
		expect(fs.readFileSync(path.join(f.cwd, "a.txt"), "utf8")).toBe("a.txt two\n");
		expect(fs.readFileSync(path.join(f.cwd, "b.txt"), "utf8")).toBe("b.txt one\n");
		expect(fs.readFileSync(path.join(f.cwd, "c.txt"), "utf8")).toBe("c.txt two\n");
		// What a consumer reads is the outcomes, not the error flag.
		expect(appliedFileOutcomes(result.details).map((outcome) => outcome.path)).toEqual(["a.txt", "c.txt"]);
		expect(result.details.receipts).toHaveLength(2);
	});

	it("throws with the count when every query of the batch failed", async () => {
		const f = setup();
		await expect(f.run([f.edit("a.txt", "missing"), f.edit("b.txt", "missing")])).rejects.toThrow(
			/^2 of 2 failed\n1\. FAILED edit a\.txt/,
		);
	});

	it("keeps the plain text for a batch that succeeded and for a single failed query", async () => {
		const f = setup();
		const ok = await f.run([f.edit("a.txt", "one"), f.edit("b.txt", "one")]);
		expect(ok.isError).toBeUndefined();
		expect(ok.content[0].text).toMatch(/^1\. OK edit a\.txt/);
		await expect(f.run([f.edit("c.txt", "missing")])).rejects.toThrow(/^1\. FAILED edit c\.txt/);
	});

	it("leads only a queries batch of more than one with the count", () => {
		const failed = { type: "edit", path: "a", reason: "r", ok: false, message: "no match" } as never;
		expect(batchText([failed], 1, 1)).toBe("1. FAILED edit a: no match");
		expect(batchText([failed], 1, undefined)).toBe("1. FAILED edit a: no match");
		expect(batchText([failed, failed], 2, 2)).toMatch(/^2 of 2 failed\n1\. FAILED/);
	});
});

describe("what later reads of a partly failed batch still see", () => {
	const details = {
		outcomes: [
			{ type: "edit", path: "a.txt", ok: true, message: "ok" },
			{ type: "edit", path: "b.txt", ok: false, message: "no match" },
		],
	};
	const result = { role: "toolResult", toolCallId: "c1", toolName: "file", isError: true, details, content: [] };

	it("lists the applied file as seen, not the failed one", () => {
		const seen = seenFiles([{ id: "e1", message: result }] as never, "/w");
		expect([...seen.keys()]).toEqual(["/w/a.txt"]);
	});

	it("adds the applied file to the compaction's modified list", () => {
		const call = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "file", arguments: {} }] };
		const fileOps = { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() };
		addFileToolOps({ fileOps, messagesToSummarize: [call, result], turnPrefixMessages: [] } as never, "/w");
		expect([...fileOps.edited]).toEqual(["a.txt"]);
	});
});
