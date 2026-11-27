import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { FauxResponseStep } from "@octocodeai/octocode-ai/compat";
import { expect, it } from "vitest";
import { createReadToolDefinition } from "./fixtures/read-tool.ts";
import { Checkpoints } from "../src/octocode/files/checkpoint.ts";
import { registerFileTool } from "../src/octocode/native/tools/file/tool.ts";
import { registerHooks } from "../src/octocode/hooks/register.ts";
import { Permission } from "../src/octocode/permission/ask.ts";
import { createHarness, getMessageText, getToolResult } from "./suite/harness.ts";
import { HOOK_SETTINGS } from "./octocode/helpers.ts";
import { approveFixtureHooks } from "./octocode/guard-helpers.ts";
import "../src/octocode/mcp-host/core-install.ts";
import { FileGuard } from "../src/octocode/files/tool/guard.ts";
import { testFeatures } from "./helpers/features.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
async function fixture(patch: string, mode = "full", once = false, claudeGate: boolean | "failClosed" = false) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "patch-update-session-"));
	const captured = path.join(home, "pre.json");
	const claudeCaptured = path.join(home, "claude-invoked");
	if (claudeGate) {
		fs.mkdirSync(path.join(home, ".claude"));
		const script = path.join(home, "claude-gate.cjs");
		fs.writeFileSync(
			script,
			`require('node:fs').writeFileSync(${JSON.stringify(claudeCaptured)},'invoked');console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'destination policy'}}));`,
		);
		fs.writeFileSync(
			path.join(home, ".claude/settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "^Write$",
							hooks: [
								{
									type: "command",
									command: `${quote(process.execPath)} ${quote(script)}`,
									...(claudeGate === "failClosed" ? { failClosed: true } : {}),
								},
							],
						},
					],
				},
			}),
		);
	}

	const script = path.join(home, "hook.cjs");
	const output = {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			updatedInput: { command: patch },
		},
	};
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(
		script,
		`const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const repeat=fs.existsSync(${JSON.stringify(captured)});fs.writeFileSync(${JSON.stringify(captured)},input);console.log(${once} && repeat ? '{}' : ${JSON.stringify(JSON.stringify(output))});});`,
	);
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "^apply_patch$",
						hooks: [
							{
								type: "command",
								command: `${quote(process.execPath)} ${quote(script)}`,
							},
						],
					},
				],
			},
		}),
	);
	const guard = new FileGuard();
	const checkpoints = new Checkpoints();
	checkpoints.open(path.join(home, "checkpoints"));
	checkpoints.beginTurn();
	const harness = await createHarness({
		tools: [],
		settings: { retry: { enabled: false }, ...HOOK_SETTINGS },
		features: testFeatures([
			(api) => {
				const permission = new Permission({
					api,
					env: { OCTOCODE_PERMISSION: mode },
					isSubagent: false,
					stderr: () => {},
				});
				api.bus.on("session_start", async (_event, ctx) => permission.start(ctx));
				api.tools.register(createReadToolDefinition(process.cwd()));
				registerFileTool(api, guard, permission, checkpoints);
				const hooks = registerHooks(api, { env: {}, home });
				api.bus.on("tool_call", (event, ctx) => hooks.preToolUse(event, ctx));
			},
		]),
	});
	approveFixtureHooks(harness.tempDir, home);
	await harness.session.bindFeatures({});
	return {
		home,
		harness,
		guard,
		checkpoints,
		captured,
		claudeCaptured,
		cleanup: () => {
			harness.cleanup();
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(
	f: Fixture,
	reads: Array<{ name: string; offset?: number; limit?: number }> = [],
	beforeFile?: () => void,
) {
	const responses: FauxResponseStep[] = reads.map(({ name, ...range }) =>
		fauxAssistantMessage(
			[
				fauxToolCall("read", {
					path: path.join(f.harness.tempDir, name),
					...range,
				}),
			],
			{ stopReason: "toolUse" },
		),
	);
	responses.push(() => {
		beforeFile?.();
		return fauxAssistantMessage(
			[
				fauxToolCall("file", {
					reason: "Apply the fixture mutation",
					queries: [
						{
							type: "write",
							path: "original.txt",
							content: "original\n",
							reason: "Fixture mutation",
						},
					],
				}),
			],
			{ stopReason: "toolUse" },
		);
	}, fauxAssistantMessage("result inspected"));
	f.harness.setResponses(responses);
	await f.harness.session.prompt("Apply the fixture mutation.");
	expect(JSON.parse(fs.readFileSync(f.captured, "utf8")).tool_name).toBe("apply_patch");
	expect(fs.existsSync(path.join(f.harness.tempDir, "original.txt"))).toBe(false);
	return getToolResult(f.harness, "file");
}

it.each([
	{
		name: "line context",
		before: "before\nold\nafter\n",
		body: "@@\n before\n-old\n+new\n after",
		after: "before\nnew\nafter\n",
	},
	{
		name: "exact before whitespace fallback",
		before: "old \nold\n",
		body: "@@\n-old\n+new",
		after: "old \nnew\n",
	},
	{
		name: "trailing whitespace fallback",
		before: "old  \n",
		body: "@@\n-old\n+new",
		after: "new\n",
	},
	{
		name: "trim fallback",
		before: "  old  \n",
		body: "@@\n-old\n+new",
		after: "new\n",
	},
	{
		name: "Unicode punctuation fallback",
		before: "say “hello”—now\n",
		body: '@@\n-say "hello"-now\n+new',
		after: "new\n",
	},
	{
		name: "EOF selection",
		before: "old\nmiddle\nold\n",
		body: "@@\n-old\n+new\n*** End of File",
		after: "old\nmiddle\nnew\n",
	},
	{
		name: "mixed endings preserve context",
		before: "first\r\nold\nlast\r",
		body: "@@\n first\n-old\n+new\n last",
		after: "first\r\nnew\r\nlast\r",
	},
	{
		name: "unterminated source",
		before: "old",
		body: "@@\n-old\n+new",
		after: "new\n",
	},
	{
		name: "sequential context cursors",
		before: "section\nold\nsection\nold\n",
		body: "@@ section\n-old\n+first\n@@ section\n-old\n+second",
		after: "section\nfirst\nsection\nsecond\n",
	},
])("executes rewritten Update with $name", async ({ before, body, after }) => {
	const f = await fixture(envelope(`*** Update File: source.txt\n${body}`));
	try {
		const target = path.join(f.harness.tempDir, "source.txt");
		fs.writeFileSync(target, before);
		const result = await run(f, [{ name: "source.txt" }]);
		expect(getMessageText(result)).not.toContain("Invalid hook input rewrite");
		expect(result.isError).toBe(false);
		expect(fs.readFileSync(target, "utf8")).toBe(after);
	} finally {
		f.cleanup();
	}
});

it("moves updated bytes and rewinds both source and newly created destination", async () => {
	const f = await fixture(envelope("*** Update File: source.txt\n*** Move to: moved.txt\n@@\n-old\n+new"));
	try {
		const source = path.join(f.harness.tempDir, "source.txt"),
			destination = path.join(f.harness.tempDir, "moved.txt");
		fs.writeFileSync(source, "old\n");
		expect((await run(f, [{ name: "source.txt" }])).isError).toBe(false);
		expect(fs.existsSync(source)).toBe(false);
		expect(fs.readFileSync(destination, "utf8")).toBe("new\n");
		const undo = await f.checkpoints.rewind(f.checkpoints.turns());
		expect(undo.skipped).toEqual([]);
		expect(undo.partly).toEqual([]);
		expect(fs.readFileSync(source, "utf8")).toBe("old\n");
		expect(fs.existsSync(destination)).toBe(false);
	} finally {
		f.cleanup();
	}
});

it.each(["invalid update", "missing delete"])("preverifies a later %s before an earlier Add", async (failure) => {
	const later =
		failure === "invalid update" ? "*** Update File: source.txt\n@@\n-missing\n+new" : "*** Delete File: missing.txt";
	const f = await fixture(envelope(`*** Add File: earlier.txt\n+must not exist\n${later}`));
	try {
		fs.writeFileSync(path.join(f.harness.tempDir, "source.txt"), "old\n");
		const result = await run(f, [{ name: "source.txt" }]);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).not.toContain("Only Add File and Delete File");
		expect(fs.existsSync(path.join(f.harness.tempDir, "earlier.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(f.harness.tempDir, "source.txt"), "utf8")).toBe("old\n");
	} finally {
		f.cleanup();
	}
});

it.each(["unread source", "reserved destination"])(
	"preserves %s guards for rewritten Update/Move",
	async (safeguard) => {
		const f = await fixture(envelope("*** Update File: source.txt\n*** Move to: moved.txt\n@@\n-old\n+new"));
		try {
			const source = path.join(f.harness.tempDir, "source.txt"),
				destination = path.join(f.harness.tempDir, "moved.txt");
			fs.writeFileSync(source, "old\n");
			if (safeguard === "reserved destination")
				f.guard.reservedBy = (file) => (file === destination ? "Reserved destination fixture" : undefined);
			const result = await run(f, safeguard === "unread source" ? [] : [{ name: "source.txt" }]);
			expect(result.isError).toBe(true);
			expect(getMessageText(result)).toMatch(
				safeguard === "unread source" ? /not read/ : /Reserved destination fixture/,
			);
			expect(fs.readFileSync(source, "utf8")).toBe("old\n");
			expect(fs.existsSync(destination)).toBe(false);
		} finally {
			f.cleanup();
		}
	},
);

it("rejects duplicate resolved source paths before creating either Add", async () => {
	const f = await fixture(envelope("*** Add File: same.txt\n+first\n*** Add File: ./same.txt\n+second"));
	try {
		const result = await run(f);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/duplicate|same path/i);
		expect(fs.existsSync(path.join(f.harness.tempDir, "same.txt"))).toBe(false);
	} finally {
		f.cleanup();
	}
});

it("does not overwrite a source whose anchor disappeared after the model read it", async () => {
	const f = await fixture(envelope("*** Update File: source.txt\n@@\n-old\n+new"));
	try {
		const source = path.join(f.harness.tempDir, "source.txt");
		fs.writeFileSync(source, "old\n");
		const result = await run(f, [{ name: "source.txt" }], () => fs.writeFileSync(source, "external change\n"));
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).not.toContain("Only Add File and Delete File");
		expect(fs.readFileSync(source, "utf8")).toBe("external change\n");
	} finally {
		f.cleanup();
	}
});

it("preserves the first committed change and checkpoint when cancellation stops a later mutation", async () => {
	const f = await fixture(envelope("*** Add File: first.txt\n+first\n*** Add File: later.txt\n+later"));
	try {
		const first = path.join(f.harness.tempDir, "first.txt"),
			later = path.join(f.harness.tempDir, "later.txt");
		const settle = f.checkpoints.settle.bind(f.checkpoints);
		let cancelled = false;
		f.checkpoints.settle = async (...args) => {
			await settle(...args);
			if (args[0] === first && args[2]) {
				cancelled = true;
				void f.harness.session.abort();
			}
		};
		await run(f);
		expect(cancelled).toBe(true);
		expect(fs.readFileSync(first, "utf8")).toBe("first\n");
		expect(fs.existsSync(later)).toBe(false);
		expect(f.checkpoints.turns()).not.toHaveLength(0);
		const undo = await f.checkpoints.rewind(f.checkpoints.turns());
		expect(undo.skipped).toEqual([]);
		expect(fs.existsSync(first)).toBe(false);
	} finally {
		f.cleanup();
	}
});

it("requires approval for a rewritten move destination outside the workspace", async () => {
	const outside = `../outside-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
	const f = await fixture(
		envelope(`*** Update File: source.txt\n*** Move to: ${outside}\n@@\n-old\n+new`),
		"workspace",
	);
	try {
		const source = path.join(f.harness.tempDir, "source.txt"),
			destination = path.resolve(f.harness.tempDir, outside);
		fs.writeFileSync(source, "old\n");
		const result = await run(f, [{ name: "source.txt" }]);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/needs approval/);
		expect(fs.readFileSync(source, "utf8")).toBe("old\n");
		expect(fs.existsSync(destination)).toBe(false);
	} finally {
		f.cleanup();
	}
});

it.each([false, true])(
	"checks destination read state before overwrite and rewinds an approved overwrite: read=%s",
	async (readDestination) => {
		const f = await fixture(envelope("*** Update File: source.txt\n*** Move to: existing.txt\n@@\n-old\n+new"));
		try {
			const source = path.join(f.harness.tempDir, "source.txt"),
				destination = path.join(f.harness.tempDir, "existing.txt");
			fs.writeFileSync(source, "old\n");
			fs.writeFileSync(destination, "prior destination\n");
			const result = await run(f, [{ name: "source.txt" }, ...(readDestination ? [{ name: "existing.txt" }] : [])]);
			if (!readDestination) {
				expect(result.isError).toBe(true);
				expect(getMessageText(result)).toMatch(/not read/);
				expect(fs.readFileSync(source, "utf8")).toBe("old\n");
				expect(fs.readFileSync(destination, "utf8")).toBe("prior destination\n");
			} else {
				expect(result.isError).toBe(false);
				expect(fs.existsSync(source)).toBe(false);
				expect(fs.readFileSync(destination, "utf8")).toBe("new\n");
				const undo = await f.checkpoints.rewind(f.checkpoints.turns());
				expect(undo.skipped).toEqual([]);
				expect(undo.partly).toEqual([]);
				expect(fs.readFileSync(source, "utf8")).toBe("old\n");
				expect(fs.readFileSync(destination, "utf8")).toBe("prior destination\n");
			}
		} finally {
			f.cleanup();
		}
	},
);

it("allows a focused Update after a partial read while preserving unseen lines", async () => {
	const f = await fixture(envelope("*** Update File: source.txt\n@@\n-old\n+new"));
	try {
		const source = path.join(f.harness.tempDir, "source.txt");
		fs.writeFileSync(source, "unseen before\nold\nunseen after\n");
		expect((await run(f, [{ name: "source.txt", offset: 2, limit: 1 }])).isError).toBe(false);
		expect(fs.readFileSync(source, "utf8")).toBe("unseen before\nnew\nunseen after\n");
	} finally {
		f.cleanup();
	}
});

it("revalidates an unchanged unique anchor over an external unrelated change", async () => {
	const f = await fixture(envelope("*** Update File: source.txt\n@@\n-old\n+new"));
	try {
		const source = path.join(f.harness.tempDir, "source.txt");
		fs.writeFileSync(source, "old\n");
		const result = await run(f, [{ name: "source.txt" }], () => fs.writeFileSync(source, "old\nexternal addition\n"));
		expect(result.isError).toBe(false);
		expect(fs.readFileSync(source, "utf8")).toBe("new\nexternal addition\n");
	} finally {
		f.cleanup();
	}
});

it("rejects an anchor made ambiguous by an external change after reading", async () => {
	const f = await fixture(envelope("*** Update File: source.txt\n@@\n-old\n+new"));
	try {
		const source = path.join(f.harness.tempDir, "source.txt");
		fs.writeFileSync(source, "old\n");
		const result = await run(f, [{ name: "source.txt" }], () => fs.writeFileSync(source, "old\nold\n"));
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/matches 2|unique|ambiguous/);
		expect(fs.readFileSync(source, "utf8")).toBe("old\nold\n");
	} finally {
		f.cleanup();
	}
});

it("accepts the canonical patch alternative directly through the public file tool schema", async () => {
	const command = envelope("*** Add File: canonical.txt\n+canonical");
	const f = await fixture(command);
	try {
		f.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("file", {
						patch: command,
						reason: "Canonical patch fixture",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await f.harness.session.prompt("Apply canonical patch.");
		expect(getToolResult(f.harness, "file").isError).toBe(false);
		expect(JSON.parse(fs.readFileSync(f.captured, "utf8")).tool_input).toEqual({
			command,
		});
		expect(fs.readFileSync(path.join(f.harness.tempDir, "canonical.txt"), "utf8")).toBe("canonical\n");
	} finally {
		f.cleanup();
	}
});

it("refuses a move overwrite when the destination was only partly read", async () => {
	const f = await fixture(envelope("*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-old\n+new"));
	try {
		const source = path.join(f.harness.tempDir, "source.txt"),
			destination = path.join(f.harness.tempDir, "destination.txt");
		fs.writeFileSync(source, "old\n");
		fs.writeFileSync(destination, "seen\nunseen\n");
		const result = await run(f, [{ name: "source.txt" }, { name: "destination.txt", offset: 1, limit: 1 }]);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/whole file|every line|read the rest/i);
		expect(fs.readFileSync(source, "utf8")).toBe("old\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("seen\nunseen\n");
	} finally {
		f.cleanup();
	}
});

it("aborts before the first commit without leaving a mutation or rewind entry", async () => {
	const f = await fixture(envelope("*** Add File: first.txt\n+first\n*** Add File: later.txt\n+later"));
	try {
		const capture = f.checkpoints.capture.bind(f.checkpoints);
		let cancelled = false;
		f.checkpoints.capture = async (...args) => {
			const result = await capture(...args);
			cancelled = true;
			void f.harness.session.abort();
			return result;
		};
		await run(f);
		expect(cancelled).toBe(true);
		expect(fs.existsSync(path.join(f.harness.tempDir, "first.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.harness.tempDir, "later.txt"))).toBe(false);
		expect(f.checkpoints.turns()).toEqual([]);
	} finally {
		f.cleanup();
	}
});

it("stops later patch mutations when a peer reserves the second target after the first commit", async () => {
	const f = await fixture(
		envelope("*** Add File: first.txt\n+first\n*** Add File: second.txt\n+second\n*** Add File: third.txt\n+third"),
	);
	try {
		const first = path.join(f.harness.tempDir, "first.txt"),
			second = path.join(f.harness.tempDir, "second.txt"),
			third = path.join(f.harness.tempDir, "third.txt");
		const settle = f.checkpoints.settle.bind(f.checkpoints);
		let reserved = false;
		f.guard.reservedBy = (file) => (reserved && file === second ? "Peer reserved target after preflight" : undefined);
		f.checkpoints.settle = async (...args) => {
			await settle(...args);
			if (args[0] === first && args[2]) reserved = true;
		};
		const result = await run(f);
		expect(reserved).toBe(true);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Peer reserved target after preflight");
		expect(fs.readFileSync(first, "utf8")).toBe("first\n");
		expect(fs.existsSync(second)).toBe(false);
		expect(fs.existsSync(third)).toBe(false);
		const undo = await f.checkpoints.rewind(f.checkpoints.turns());
		expect(undo.skipped).toEqual([]);
		expect(fs.existsSync(first)).toBe(false);
	} finally {
		f.cleanup();
	}
});

it("matches a same-path Move's source behavior and can rewind its deletion", async () => {
	const f = await fixture(envelope("*** Update File: source.txt\n*** Move to: source.txt\n@@\n-old\n+new"));
	try {
		const source = path.join(f.harness.tempDir, "source.txt");
		fs.writeFileSync(source, "old\n");
		const result = await run(f, [{ name: "source.txt" }]);
		expect(result.isError).toBe(false);
		expect(fs.existsSync(source)).toBe(false);
		const undo = await f.checkpoints.rewind(f.checkpoints.turns());
		expect(undo.skipped).toEqual([]);
		expect(undo.partly).toEqual([]);
		expect(fs.readFileSync(source, "utf8")).toBe("old\n");
	} finally {
		f.cleanup();
	}
});

it("does not upgrade partial read coverage after a successful patch Update", async () => {
	const f = await fixture(envelope("*** Update File: source.txt\n@@\n-old\n+new"), "full", true);
	try {
		const source = path.join(f.harness.tempDir, "source.txt");
		fs.writeFileSync(source, "before\nold\nafter\n");
		expect((await run(f, [{ name: "source.txt", offset: 2, limit: 1 }])).isError).toBe(false);
		f.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("file", {
						reason: "Overwrite the source",
						queries: [
							{
								type: "write",
								path: "source.txt",
								content: "overwrite\n",
								reason: "Coverage regression",
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("refusal accepted"),
		]);
		await f.harness.session.prompt("Try a whole-file replacement without rereading.");
		const result = getToolResult(f.harness, "file");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/whole file|every line|read the rest/i);
		expect(fs.readFileSync(source, "utf8")).toBe("before\nnew\nafter\n");
	} finally {
		f.cleanup();
	}
});

it("keeps stale status after applying a valid patch anchor over external changes", async () => {
	const f = await fixture(envelope("*** Update File: source.txt\n@@\n-old\n+new"), "full", true);
	try {
		const source = path.join(f.harness.tempDir, "source.txt");
		fs.writeFileSync(source, "old\n");
		expect((await run(f, [{ name: "source.txt" }], () => fs.writeFileSync(source, "old\nexternal\n"))).isError).toBe(
			false,
		);
		f.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("file", {
						reason: "Delete the source",
						queries: [
							{
								type: "delete",
								path: "source.txt",
								reason: "Stale regression",
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("refusal accepted"),
		]);
		await f.harness.session.prompt("Try deletion without rereading.");
		const result = getToolResult(f.harness, "file");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/changed on disk/);
		expect(fs.readFileSync(source, "utf8")).toBe("new\nexternal\n");
	} finally {
		f.cleanup();
	}
});

it("runs a canonical Move without the Claude Write gate that cannot see it losslessly, and refuses only a failClosed gate", async () => {
	const command = envelope("*** Update File: source.txt\n*** Move to: protected.txt\n@@\n-old\n+new");
	for (const gate of [true, "failClosed"] as const) {
		const f = await fixture(command, "full", false, gate);
		try {
			const source = path.join(f.harness.tempDir, "source.txt"),
				destination = path.join(f.harness.tempDir, "protected.txt");
			fs.writeFileSync(source, "old\n");
			f.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: source })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						fauxToolCall("file", {
							patch: command,
							reason: "Cross-profile move",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("gate outcome accepted"),
			]);
			await f.harness.session.prompt("Move the source.");
			const result = getToolResult(f.harness, "file");
			// The per-query Claude hook never sees a canonical patch, so it is not run either way.
			expect(fs.existsSync(f.claudeCaptured)).toBe(false);
			if (gate === "failClosed") {
				expect(result.isError).toBe(true);
				expect(getMessageText(result)).toMatch(/cannot be represented losslessly/);
				expect(fs.existsSync(f.captured)).toBe(false);
				expect(fs.readFileSync(source, "utf8")).toBe("old\n");
				expect(fs.existsSync(destination)).toBe(false);
			} else {
				// Hooks fail open: the move runs with the gate skipped (and reported), as a crashed hook would be.
				expect(result.isError).toBeFalsy();
				expect(fs.existsSync(source)).toBe(false);
				expect(fs.readFileSync(destination, "utf8")).toBe("new\n");
			}
		} finally {
			f.cleanup();
		}
	}
});

it("rejects both input modes before invoking a source hook", async () => {
	const command = envelope("*** Add File: canonical.txt\n+canonical");
	const f = await fixture(command);
	try {
		f.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("file", {
						patch: command,
						reason: "Ambiguous fixture",
						queries: [
							{
								type: "write",
								path: "native.txt",
								content: "native\n",
								reason: "Ambiguous fixture",
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("refusal accepted"),
		]);
		await f.harness.session.prompt("Try ambiguous input.");
		expect(getToolResult(f.harness, "file").isError).toBe(true);
		expect(fs.existsSync(f.captured)).toBe(false);
		expect(fs.existsSync(path.join(f.harness.tempDir, "canonical.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.harness.tempDir, "native.txt"))).toBe(false);
	} finally {
		f.cleanup();
	}
});

it("prechecks copied output markers in later Add content before earlier patch effects", async () => {
	const f = await fixture(
		envelope(
			"*** Add File: earlier.txt\n+earlier\n*** Add File: marker.txt\n+[Output trimmed: \x73howing 10 of 20 lines]",
		),
	);
	try {
		const result = await run(f);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/placeholder|output.*cut|trimmed/i);
		expect(fs.existsSync(path.join(f.harness.tempDir, "earlier.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.harness.tempDir, "marker.txt"))).toBe(false);
	} finally {
		f.cleanup();
	}
});

it("refuses overlapping move targets during preflight instead of applying stale precomputed output", async () => {
	const f = await fixture(
		envelope(
			"*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-old\n+moved\n*** Update File: destination.txt\n@@\n-prior\n+later",
		),
	);
	try {
		const source = path.join(f.harness.tempDir, "source.txt"),
			destination = path.join(f.harness.tempDir, "destination.txt");
		fs.writeFileSync(source, "old\n");
		fs.writeFileSync(destination, "prior\n");
		const result = await run(f, [{ name: "source.txt" }, { name: "destination.txt" }]);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/overlap|multiple.*target/i);
		expect(fs.readFileSync(source, "utf8")).toBe("old\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("prior\n");
	} finally {
		f.cleanup();
	}
});
