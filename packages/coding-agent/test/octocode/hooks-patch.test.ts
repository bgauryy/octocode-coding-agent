import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

import { projectCodexPatch, rewriteCodexPatch } from "../../src/octocode/hooks/patch.ts";

const input = {
	queries: [
		{
			type: "write",
			path: "new.txt",
			content: "hello\n+world\n",
			reason: "create",
		},
		{ type: "delete", path: "old.txt", reason: "remove" },
	],
};
const command = "*** Begin Patch\n*** Add File: new.txt\n+hello\n++world\n*** Delete File: old.txt\n*** End Patch";
it("projects a whole batch and retains rewritten command text in canonical mode", () => {
	expect(projectCodexPatch(input)).toBe(command);
	const replacement = rewriteCodexPatch(input, { command });
	expect(replacement).toEqual({ patch: command, reason: "create; remove" });
	expect(projectCodexPatch(replacement)).toBe(command);
	const changed = command.replace("new.txt", "other.txt").replace("+hello", "+changed");
	expect(rewriteCodexPatch(input, { command: changed, ignored: true })).toEqual({
		patch: changed,
		reason: "create; remove",
	});
});
it("rejects lossy or ambiguous projections instead of silently modifying content", () => {
	for (const content of ["no newline", "CRLF\r\n"])
		expect(() => projectCodexPatch({ queries: [{ ...input.queries[0], content }] })).toThrow(/lossless/i);
	expect(() =>
		projectCodexPatch({
			queries: [
				{
					type: "edit",
					path: "x",
					edits: [{ oldText: "middle", newText: "replacement" }],
				},
			],
		}),
	).toThrow(/snapshot/i);
	expect(() =>
		projectCodexPatch({
			queries: [{ ...input.queries[0], path: "x\n*** Delete File: secret" }],
		}),
	).toThrow(/path/i);
	expect(projectCodexPatch({ queries: [{ ...input.queries[0], content: "" }] })).toBe(
		"*** Begin Patch\n*** Add File: new.txt\n*** End Patch",
	);
});
it("rejects malformed patches atomically", () => {
	for (const patch of ["bad", "*** Begin Patch\n*** Update File: x\n@@\n*** End Patch", command + "\ntrailing"]) {
		expect(() => rewriteCodexPatch(input, { command: patch })).toThrow();
	}
	expect(input.queries[0].path).toBe("new.txt");
});

it("allows a rewritten patch to change the batch size and operations", () => {
	expect(
		rewriteCodexPatch(input, {
			command: "*** Begin Patch\n*** Delete File: another.txt\n*** End Patch",
		}),
	).toEqual({
		patch: "*** Begin Patch\n*** Delete File: another.txt\n*** End Patch",
		reason: "create; remove",
	});
});

afterEach(() => vi.unstubAllEnvs());

async function fixture(matcher = "apply_patch", rewrite?: string) {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".codex"));
	const capture = path.join(home, "calls.jsonl");
	const script = path.join(home, "hook.cjs");
	fs.writeFileSync(
		script,
		`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(capture)},s+'\\n');${rewrite === undefined ? "" : `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:${JSON.stringify(rewrite)}}}}));`}});`,
	);
	const hooks = [
		{
			matcher,
			hooks: [{ type: "command", command: `${process.execPath} ${script}` }],
		},
	];
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: { PreToolUse: hooks, ...(rewrite ? {} : { PostToolUse: hooks }) },
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	fake.tools.set("file", {
		name: "file",
		description: "Files",
		parameters: Type.Object({
			queries: Type.Array(
				Type.Object({
					type: Type.Literal("write"),
					path: Type.String(),
					content: Type.String(),
					reason: Type.String(),
				}),
			),
		}),
	});
	const view = registerHooks(fake.api, { env: {}, home });
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	return { fake, view, ctx, capture };
}
it("dispatches one Codex batch with the original tool id and reuses its pre-call patch at post", async () => {
	const { fake, view, ctx, capture } = await fixture();
	const event = {
		toolName: "file",
		toolCallId: "patch-id",
		input: structuredClone(input),
	};
	expect(await view.preToolUse(event as never, ctx)).toBeUndefined();
	event.input.queries[0].content = "changed\n";
	await fake.fire(
		"tool_result",
		{
			...event,
			isError: false,
			content: [{ type: "text", text: "done" }],
			details: { outcomes: [{ ok: true }, { ok: true }] },
		},
		ctx,
	);
	const calls = fs
		.readFileSync(capture, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(calls).toHaveLength(2);
	expect(calls.map((call) => [call.hook_event_name, call.tool_name, call.tool_use_id, call.tool_input])).toEqual([
		["PreToolUse", "apply_patch", "patch-id", { command }],
		["PostToolUse", "apply_patch", "patch-id", { command }],
	]);
});
it("runs a native input the Codex apply_patch gate cannot see losslessly without that hook, never blocking it", async () => {
	for (const matcher of ["apply_patch", "Bash"]) {
		const { view, ctx, capture } = await fixture(matcher);
		const event = {
			toolName: "file",
			toolCallId: "partial",
			input: { queries: [{ ...input.queries[0], content: "no newline" }] },
		};
		// Hooks fail open: the write goes ahead, the unprojectable hook is skipped (and reported), not run.
		expect(await view.preToolUse(event as never, ctx)).toBeUndefined();
		expect(fs.existsSync(capture)).toBe(false);
	}
});
it("revalidates rewritten patch operations against the registered native schema before mutation", async () => {
	const { view, ctx } = await fixture("apply_patch", "*** Begin Patch\n*** Delete File: forbidden.txt\n*** End Patch");
	const event = {
		toolName: "file",
		toolCallId: "schema",
		input: { queries: [structuredClone(input.queries[0])] },
	};
	expect(await view.preToolUse(event as never, ctx)).toMatchObject({
		block: true,
		reason: expect.stringContaining("Invalid hook input rewrite"),
	});
	expect(event.input.queries).toEqual([input.queries[0]]);
});

it.each(["Edit", "Write"])("matches the Codex %s alias while sending the canonical batch name", async (matcher) => {
	const { view, ctx, capture } = await fixture(matcher);
	await view.preToolUse(
		{
			toolName: "file",
			toolCallId: "alias",
			input: structuredClone(input),
		} as never,
		ctx,
	);
	expect(fs.existsSync(capture)).toBe(true);
	const calls = fs
		.readFileSync(capture, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(calls).toHaveLength(1);
	expect(calls[0].tool_name).toBe("apply_patch");
	expect(calls[0].tool_input).toEqual({ command });
});

it.each([
	"@file.txt",
	"space\u00a0file.txt",
	"~/file.txt",
	"~",
	"file:///tmp/example.txt",
	"ssh://host/file.txt",
	"C:\\work\\file.txt",
])("rejects path dialect changes for %s in both directions", (file) => {
	expect(() => projectCodexPatch({ queries: [{ ...input.queries[0], path: file }] })).toThrow(/path/i);
	expect(() =>
		rewriteCodexPatch(input, {
			command: `*** Begin Patch\n*** Add File: ${file}\n+data\n*** End Patch`,
		}),
	).toThrow(/path/i);
});
