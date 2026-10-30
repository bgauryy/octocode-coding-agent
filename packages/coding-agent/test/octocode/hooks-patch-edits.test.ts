import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { applyEdit } from "../../src/octocode/files/tool/apply.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { projectEditHunk } from "../../src/octocode/files/tool/patch-projection.ts";
import { projectCodexPatch } from "../../src/octocode/hooks/patch.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { parsePatch, transformPatch } from "../../src/octocode/shared/codex-patch/patch.ts";
import { sha256 } from "../../src/utils/atomic-file.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

type Edit = { oldText: string; newText: string; replaceAll?: boolean; line?: number; sourceSha256?: string };

const LETTERS = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n";

/** A file in a fresh directory, read whole (digest known) by the guard unless `read` is false. */
function setup(content: string, read = true) {
	const cwd = tmp();
	const file = path.join(cwd, "f.txt");
	fs.writeFileSync(file, content);
	const guard = new FileGuard();
	if (read) guard.record(file, { sha256: sha256(content), size: Buffer.byteLength(content) });
	const projectEdit = (query: Record<string, unknown>, file: string, at: string) =>
		projectEditHunk(query, file, guard, at);
	return { cwd, file, guard, projectEdit, snapshots: { projectEdit, cwd } };
}

const edit = (edits: Edit[], file = "f.txt") => ({ queries: [{ type: "edit", path: file, reason: "change", edits }] });

/** What the file tool's edit engine writes for these edits. */
async function toolWrites(file: string, edits: Edit[]): Promise<string> {
	let written = "";
	await applyEdit(file, "f.txt", edits, {
		readFile: async () => fs.readFileSync(file),
		writeFile: async (_file, content) => {
			written = content;
		},
		access: async () => {},
		mkdir: async () => {},
	});
	return written;
}

/** The projected patch applied by the Codex patch applier to the file's current bytes. */
function patched(command: string, file: string): string {
	const [hunk] = parsePatch(command).hunks;
	if (hunk.kind !== "update") throw new Error("expected an update hunk");
	return transformPatch(fs.readFileSync(file, "utf8"), hunk.chunks);
}

it("projects a single edit as an Update hunk with whole-line context", async () => {
	const { file, snapshots } = setup(LETTERS);
	const edits = [{ oldText: "e\nf", newText: "E\nF" }];
	const command = projectCodexPatch(edit(edits), snapshots);
	expect(command).toBe(
		"*** Begin Patch\n*** Update File: f.txt\n@@\n b\n c\n d\n-e\n-f\n+E\n+F\n g\n h\n i\n*** End Patch",
	);
	expect(patched(command, file)).toBe(await toolWrites(file, edits));
});

it("projects several edits of one query as separate chunks, and replaceAll as every occurrence", async () => {
	const several = setup(LETTERS);
	const edits = [
		{ oldText: "b", newText: "B" },
		{ oldText: "o", newText: "O" },
	];
	const command = projectCodexPatch(edit(edits), several.snapshots);
	expect(command.match(/^@@$/gm)).toHaveLength(2);
	expect(patched(command, several.file)).toBe(await toolWrites(several.file, edits));

	const all = setup("x = 1\ny = 2\nx = 3\n");
	const replaceAll = [{ oldText: "x", newText: "z", replaceAll: true }];
	const projected = projectCodexPatch(edit(replaceAll), all.snapshots);
	expect(patched(projected, all.file)).toBe("z = 1\ny = 2\nz = 3\n");
	expect(patched(projected, all.file)).toBe(await toolWrites(all.file, replaceAll));
});

it("resolves line anchors with sourceSha256 like the file tool, and keeps CRLF endings", () => {
	const anchored = setup("same\nsame\nother\n");
	const sourceSha256 = sha256("same\nsame\nother\n");
	const command = projectCodexPatch(
		edit([{ oldText: "same", newText: "changed", line: 2, sourceSha256 }]),
		anchored.snapshots,
	);
	expect(patched(command, anchored.file)).toBe("same\nchanged\nother\n");
	expect(() =>
		projectCodexPatch(
			edit([{ oldText: "same", newText: "x", line: 2, sourceSha256: sha256("other") }]),
			anchored.snapshots,
		),
	).toThrow(/snapshot-aware.*anchored edit/);

	const crlf = setup("one\r\ntwo\r\n");
	expect(patched(projectCodexPatch(edit([{ oldText: "two", newText: "2" }]), crlf.snapshots), crlf.file)).toBe(
		"one\r\n2\r\n",
	);
});

it("fails closed without a verified snapshot or an exact projection", () => {
	const edits = [{ oldText: "b", newText: "B" }];
	const unread = setup(LETTERS, false);
	expect(() => projectCodexPatch(edit(edits))).toThrow(/snapshot-aware/);
	expect(() => projectCodexPatch(edit(edits), unread.snapshots)).toThrow(/snapshot-aware.*was not read/);

	const changed = setup(LETTERS);
	fs.writeFileSync(changed.file, LETTERS.replace("p", "q"));
	expect(() => projectCodexPatch(edit(edits), changed.snapshots)).toThrow(/snapshot-aware/);

	// apply_patch always ends lines with a newline, so a file without a final one cannot round-trip.
	const unterminated = setup("a\nb");
	expect(() => projectCodexPatch(edit(edits), unterminated.snapshots)).toThrow(/cannot reproduce/);

	const ambiguous = setup(LETTERS);
	expect(() => projectCodexPatch(edit([{ oldText: "\n", newText: "-" }]), ambiguous.snapshots)).toThrow(/occurrences/);
	expect(() =>
		projectCodexPatch(
			{ queries: [...edit(edits).queries, { type: "delete", path: "./f.txt", reason: "remove" }] },
			ambiguous.snapshots,
		),
	).toThrow(/more than one query/);
});

afterEach(() => vi.unstubAllEnvs());

it("runs matching Codex PreToolUse and PostToolUse hooks for edit queries with one projected patch", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".codex"));
	const capture = path.join(home, "calls.jsonl");
	const script = path.join(home, "hook.cjs");
	fs.writeFileSync(
		script,
		`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>require('fs').appendFileSync(${JSON.stringify(capture)},s+'\\n'));`,
	);
	const hooks = [
		{ matcher: "^(?:apply_patch|Write|Edit)$", hooks: [{ type: "command", command: `${process.execPath} ${script}` }] },
	];
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({ hooks: { PreToolUse: hooks, PostToolUse: hooks } }),
	);
	const { cwd, file, projectEdit, snapshots } = setup(LETTERS);
	const fake = fakeHost();
	const view = registerHooks(fake.api, {}, home, undefined, undefined, undefined, projectEdit);
	const ctx = fakeCtx({ cwd, hasUI: false });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const edits = [{ oldText: "e", newText: "E" }];
	const event = { toolName: "file", toolCallId: "edit-id", input: edit(edits) };
	expect(await view.preToolUse(event as never, ctx)).toBeUndefined();
	const command = projectCodexPatch(edit(edits), snapshots);
	expect(command).toContain("*** Update File: f.txt\n@@\n b\n c\n d\n-e\n+E\n f\n g\n h\n");
	fs.writeFileSync(file, await toolWrites(file, edits));
	await fake.fire(
		"tool_result",
		{ ...event, isError: false, content: [{ type: "text", text: "done" }], details: { outcomes: [{ ok: true }] } },
		ctx,
	);
	const calls = fs
		.readFileSync(capture, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(calls.map((call) => [call.hook_event_name, call.tool_name, call.tool_use_id, call.tool_input])).toEqual([
		["PreToolUse", "apply_patch", "edit-id", { command }],
		["PostToolUse", "apply_patch", "edit-id", { command }],
	]);

	// An edit the hook cannot see losslessly runs without it (hooks fail open) and the skip is reported.
	const unread = { toolName: "file", toolCallId: "unread", input: edit(edits, "missing.txt") };
	expect(await view.preToolUse(unread as never, ctx)).toBeUndefined();
	expect(fs.readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(2);
});
