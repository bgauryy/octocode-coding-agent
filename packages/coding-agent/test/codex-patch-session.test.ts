import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { registerFileTool } from "../src/octocode/files/tool.ts";
import { registerHooks } from "../src/octocode/hooks/register.ts";
import { Permission } from "../src/octocode/permission/ask.ts";
import { createHarness, getMessageText, getToolResult } from "./suite/harness.ts";
import { FileGuard } from "../src/octocode/files/tool/guard.ts";

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(
	rewrite: string,
	mode = "full",
	options: {
		post?: boolean;
		deny?: boolean;
		claudeRewrite?: boolean;
		postOnly?: boolean;
		noHooks?: boolean;
	} = {},
) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-session-"));
	const captured = path.join(home, "captured.jsonl");
	const script = path.join(home, "hook.cjs");
	const postCaptured = path.join(home, "post.jsonl");
	const postScript = path.join(home, "post.cjs");
	fs.writeFileSync(
		postScript,
		`const fs=require('node:fs'); let data=''; process.stdin.on('data',x=>data+=x); process.stdin.on('end',()=>{ fs.appendFileSync(${JSON.stringify(postCaptured)}, data.trim()+'\\n'); console.log('{}'); });`,
	);
	const preOutput = options.deny
		? {
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: "fixture denial",
				},
			}
		: {
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "allow",
					updatedInput: { command: rewrite },
				},
			};
	if (options.claudeRewrite) {
		fs.mkdirSync(path.join(home, ".claude"));
		const claudeScript = path.join(home, "claude.cjs");
		fs.writeFileSync(
			claudeScript,
			`console.log(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { file_path: "claude.txt", content: "claude\n" } } }))});`,
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
									command: `${shellQuote(process.execPath)} ${shellQuote(claudeScript)}`,
								},
							],
						},
					],
				},
			}),
		);
	}
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(
		script,
		`const fs = require('node:fs'); let input = ''; process.stdin.on('data', x => input += x); process.stdin.on('end', () => { fs.appendFileSync(${JSON.stringify(captured)}, input.trim() + '\\n'); console.log(${JSON.stringify(JSON.stringify(preOutput))}); });`,
	);
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				...(options.post
					? {
							PostToolUse: [
								{
									matcher: "^apply_patch$",
									hooks: [
										{
											type: "command",
											command: `${shellQuote(process.execPath)} ${shellQuote(postScript)}`,
										},
									],
								},
							],
						}
					: {}),
				PreToolUse:
					options.postOnly || options.noHooks
						? []
						: [
								{
									matcher: "^apply_patch$",
									hooks: [
										{
											type: "command",
											command: `${shellQuote(process.execPath)} ${shellQuote(script)}`,
										},
									],
								},
							],
			},
		}),
	);
	const guard = new FileGuard();
	const harness = await createHarness({
		settings: { retry: { enabled: false } },
		tools: [],
		extensionFactories: [
			(api) => {
				const permission = new Permission({
					api,
					env: { OCTOCODE_PERMISSION: mode },
					isSubagent: false,
					stderr: () => {},
				});
				api.on("session_start", async (_event, ctx) => permission.start(ctx));
				registerFileTool(api, guard, permission);
				const hooks = registerHooks(api, {}, home);
				api.on("tool_call", (event, ctx) => hooks.preToolUse(event, ctx));
			},
		],
	});
	await harness.session.bindExtensions({});
	return {
		harness,
		guard,
		home,
		captured,
		postCaptured,
		cleanup: () => {
			harness.cleanup();
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

const original = {
	reason: "Write the fixture files",
	queries: [
		{
			type: "write",
			path: "first.txt",
			content: "first\n",
			reason: "First fixture file",
		},
		{
			type: "write",
			path: "second.txt",
			content: "second\n",
			reason: "Second fixture file",
		},
	],
};
const patch = (target: string) => `*** Begin Patch\n*** Add File: ${target}\n+rewritten\n*** End Patch`;

it("projects one native file batch as apply_patch and executes only its rewritten patch through AgentSession", async () => {
	const f = await fixture(patch("rewritten.txt"));
	try {
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("file", structuredClone(original))], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await f.harness.session.prompt("Apply the fixture changes.");
		const payloads = fs
			.readFileSync(f.captured, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(payloads).toHaveLength(1);
		expect(payloads[0].tool_name).toBe("apply_patch");
		expect(Object.keys(payloads[0].tool_input)).toEqual(["command"]);
		expect(payloads[0].tool_input.command).toContain("*** Add File: first.txt");
		expect(payloads[0].tool_input.command).toContain("*** Add File: second.txt");
		expect(fs.readFileSync(path.join(f.harness.tempDir, "rewritten.txt"), "utf8")).toBe("rewritten\n");
		expect(fs.existsSync(path.join(f.harness.tempDir, "first.txt"))).toBe(false);
		expect(fs.existsSync(path.join(f.harness.tempDir, "second.txt"))).toBe(false);
		expect(getToolResult(f.harness, "file").isError).toBe(false);
	} finally {
		f.cleanup();
	}
});

it.each(["unread", "stale", "reserved", "outside"])(
	"preserves the native %s safeguard after a Codex rewrite",
	async (safeguard) => {
		const requestedTarget = safeguard === "outside" ? `../outside-patch-${randomUUID()}.txt` : "protected.txt";
		const f = await fixture(patch(requestedTarget), "workspace");
		const target = path.resolve(f.harness.tempDir, requestedTarget);
		try {
			if (safeguard === "unread" || safeguard === "stale") fs.writeFileSync(target, "untouched\n");
			if (safeguard === "stale") {
				f.guard.record(target);
				fs.writeFileSync(target, "external change\n");
			}
			if (safeguard === "reserved")
				f.guard.reservedBy = (file) => (file === target ? "Reserved by peer fixture" : undefined);
			f.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("file", structuredClone(original))], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("denial accepted"),
			]);
			await f.harness.session.prompt("Apply the fixture changes.");
			expect(fs.existsSync(f.captured)).toBe(true);
			const result = getToolResult(f.harness, "file");
			expect(result.isError).toBe(true);
			expect(getMessageText(result)).toMatch(
				safeguard === "unread"
					? /not read/
					: safeguard === "stale"
						? /changed on disk/
						: safeguard === "reserved"
							? /Reserved by peer fixture/
							: /needs approval/,
			);
			if (safeguard === "unread") expect(fs.readFileSync(target, "utf8")).toBe("untouched\n");
			else if (safeguard === "stale") expect(fs.readFileSync(target, "utf8")).toBe("external change\n");
			else expect(fs.existsSync(target)).toBe(false);
			expect(fs.existsSync(path.join(f.harness.tempDir, "first.txt"))).toBe(false);
		} finally {
			f.cleanup();
		}
	},
);

it("rejects an invalid replacement patch without falling back to the original native mutations", async () => {
	const f = await fixture("*** Begin Patch\n*** Add File: rewritten.txt\nnot a patch content line\n*** End Patch");
	try {
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("file", structuredClone(original))], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("invalid rewrite accepted"),
		]);
		await f.harness.session.prompt("Apply the fixture changes.");
		expect(fs.existsSync(f.captured)).toBe(true);
		expect(getToolResult(f.harness, "file").isError).toBe(true);
		for (const name of ["first.txt", "second.txt", "rewritten.txt"])
			expect(fs.existsSync(path.join(f.harness.tempDir, name))).toBe(false);
	} finally {
		f.cleanup();
	}
});

it("reports the executed rewritten patch once to Codex PostToolUse", async () => {
	const rewritten = patch("post-rewritten.txt");
	const f = await fixture(rewritten, "full", { post: true });
	try {
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("file", structuredClone(original))], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await f.harness.session.prompt("Apply changes.");
		const payloads = fs
			.readFileSync(f.postCaptured, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(payloads).toHaveLength(1);
		expect(payloads[0].tool_name).toBe("apply_patch");
		expect(payloads[0].tool_input).toEqual({ command: rewritten });
		expect(payloads[0].tool_response).toContain("post-rewritten.txt");
		expect(fs.readFileSync(path.join(f.harness.tempDir, "post-rewritten.txt"), "utf8")).toBe("rewritten\n");
	} finally {
		f.cleanup();
	}
});

it.each(["denied", "invalid", "unread", "conflict"])(
	"does not run Codex PostToolUse for a %s call",
	async (failure) => {
		const f = await fixture(failure === "invalid" ? "not a patch" : patch("protected.txt"), "full", {
			post: true,
			deny: failure === "denied",
			claudeRewrite: failure === "conflict",
		});
		try {
			if (failure === "unread") fs.writeFileSync(path.join(f.harness.tempDir, "protected.txt"), "keep\n");
			f.harness.setResponses([
				fauxAssistantMessage([fauxToolCall("file", structuredClone(original))], { stopReason: "toolUse" }),
				fauxAssistantMessage("denial accepted"),
			]);
			await f.harness.session.prompt("Apply changes.");
			expect(fs.existsSync(f.captured)).toBe(true);
			const result = getToolResult(f.harness, "file");
			expect(result.isError).toBe(true);
			if (failure === "conflict") expect(getMessageText(result)).toContain("Conflicting source-profile file rewrites");
			expect(fs.existsSync(f.postCaptured)).toBe(false);
			for (const name of ["first.txt", "second.txt", "claude.txt"])
				expect(fs.existsSync(path.join(f.harness.tempDir, name))).toBe(false);
			if (failure === "unread")
				expect(fs.readFileSync(path.join(f.harness.tempDir, "protected.txt"), "utf8")).toBe("keep\n");
		} finally {
			f.cleanup();
		}
	},
);

it("preverifies every rewritten patch target before mutation and suppresses success posts on failure", async () => {
	const rewrite =
		"*** Begin Patch\n*** Add File: created.txt\n+created\n*** Add File: protected.txt\n+replacement\n*** End Patch";
	const f = await fixture(rewrite, "full", { post: true });
	try {
		fs.writeFileSync(path.join(f.harness.tempDir, "protected.txt"), "keep\n");
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("file", structuredClone(original))], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("partial outcome reviewed"),
		]);
		await f.harness.session.prompt("Apply changes.");
		const result = getToolResult(f.harness, "file");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("not read");
		expect(fs.existsSync(path.join(f.harness.tempDir, "created.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(f.harness.tempDir, "protected.txt"), "utf8")).toBe("keep\n");
		expect(fs.existsSync(f.postCaptured)).toBe(false);
	} finally {
		f.cleanup();
	}
});

it("retains a native delete's pre-call patch for a post-only Codex observer", async () => {
	const f = await fixture(patch("unused.txt"), "full", {
		post: true,
		postOnly: true,
	});
	try {
		const target = path.join(f.harness.tempDir, "delete.txt");
		fs.writeFileSync(target, "delete me\n");
		f.guard.record(target);
		f.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("file", {
						reason: "Delete the fixture file",
						queries: [
							{
								type: "delete",
								path: "delete.txt",
								reason: "Delete fixture",
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await f.harness.session.prompt("Delete the fixture.");
		expect(getToolResult(f.harness, "file").isError).toBe(false);
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.existsSync(f.captured)).toBe(false);
		const payloads = fs
			.readFileSync(f.postCaptured, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(payloads).toHaveLength(1);
		expect(payloads[0].tool_input).toEqual({
			command: "*** Begin Patch\n*** Delete File: delete.txt\n*** End Patch",
		});
	} finally {
		f.cleanup();
	}
});

it("preserves native query batches' continue-after-failure behavior independently of Codex patch mode", async () => {
	const f = await fixture(patch("unused.txt"), "full", { noHooks: true });
	try {
		const first = path.join(f.harness.tempDir, "first.txt"),
			second = path.join(f.harness.tempDir, "second.txt");
		fs.writeFileSync(second, "unread existing content\n");
		f.harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("file", {
						reason: "Verify the continuation",
						queries: [
							...structuredClone(original.queries),
							{
								type: "write",
								path: "third.txt",
								content: "third\n",
								reason: "Verify continuation",
							},
						],
					}),
				],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("partial native outcome reviewed"),
		]);
		await f.harness.session.prompt("Apply the native queries.");
		const result = getToolResult(f.harness, "file");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toMatch(/not read/);
		expect(fs.readFileSync(first, "utf8")).toBe("first\n");
		expect(fs.readFileSync(path.join(f.harness.tempDir, "third.txt"), "utf8")).toBe("third\n");
		expect(fs.readFileSync(second, "utf8")).toBe("unread existing content\n");
	} finally {
		f.cleanup();
	}
});
