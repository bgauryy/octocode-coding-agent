import { describe, expect, it } from "vitest";
import { hookPayload } from "../../src/octocode/hooks/profiles.ts";
import { HOOK_SETTINGS } from "./helpers.ts";

const metadata = {
	model: "model",
	turnId: "turn",
	child: {
		sessionId: "actual-child-session",
		agentName: "native-worker",
		agentType: "reviewer",
	},
};
const ordinary = ["PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "UserPromptSubmit"];

describe("source child hook identity", () => {
	it.each(ordinary)(
		"projects Codex %s with actual child identity and preserves current session/transcript",
		(event) => {
			const result = hookPayload(
				"codex",
				{
					hook_event_name: event,
					session_id: "current",
					transcript_path: "/child.jsonl",
				},
				metadata,
			);
			expect(result).toMatchObject({
				agent_id: "actual-child-session",
				agent_type: "reviewer",
				session_id: "current",
				transcript_path: "/child.jsonl",
			});
		},
	);
	it.each(["SessionStart", "SessionEnd", "Stop", "Interrupt"])(
		"does not invent Codex %s child schema fields",
		(event) => {
			const result = hookPayload("codex", { hook_event_name: event }, metadata);
			expect(result).not.toHaveProperty("agent_id");
			expect(result).not.toHaveProperty("agent_type");
		},
	);
	it.each([...ordinary, "PostToolUseFailure", "StopFailure", "Notification", "SessionEnd"])(
		"projects Claude common identity on %s",
		(event) => {
			expect(hookPayload("claude", { hook_event_name: event }, metadata)).toMatchObject({
				agent_id: "native-worker",
				agent_type: "reviewer",
			});
		},
	);
	it.each(["claude", "codex"] as const)("keeps %s lifecycle identity authoritative", (protocol) => {
		const payload = {
			hook_event_name: "SubagentStop",
			agent_id: "lifecycle-id",
			agent_type: "lifecycle-type",
			session_id: "parent",
			transcript_path: "/parent.jsonl",
			agent_transcript_path: "/child.jsonl",
		};
		expect(hookPayload(protocol, payload, metadata)).toMatchObject(payload);
	});
	it("leaves native payload unchanged and omits source child fields when no actual child exists", () => {
		const payload = { hook_event_name: "PreToolUse" };
		expect(hookPayload("octocode", payload, metadata)).toBe(payload);
		for (const protocol of ["claude", "codex"] as const)
			expect(hookPayload(protocol, payload, { model: "model" })).not.toHaveProperty("agent_id");
	});
});

it.each([false, true])("requires actual child marker (child=%s)", async (child) => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const { tmp } = await import("./helpers.ts");
	const { fakeHost, fakeCtx } = await import("./fake-host.ts");
	const { registerHooks } = await import("../../src/octocode/hooks/register.ts");
	const home = tmp(),
		cwd = tmp(),
		output = path.join(home, "captured.json");
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				PreToolUse: [{ hooks: [{ type: "command", command: `cat > '${output}'` }] }],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd });
	ctx.sessionManager.getSessionId = () => "actual-child";
	const view = registerHooks(
		fake.api,
		child ? { OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "1" } : {},
		home,
		undefined,
		() => ({ agentName: "stale-worker", agentType: "reviewer" }),
	);
	try {
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await view.preToolUse(
			{
				toolName: "bash",
				toolCallId: "call",
				input: { command: "true" },
			} as never,
			ctx,
		);
		const captured = JSON.parse(fs.readFileSync(output, "utf8"));
		if (child)
			expect(captured).toMatchObject({
				agent_id: "actual-child",
				agent_type: "reviewer",
			});
		else {
			expect(captured).not.toHaveProperty("agent_id");
			expect(captured).not.toHaveProperty("agent_type");
		}
	} finally {
		await fake.fire("session_shutdown", { reason: "quit" }, ctx);
	}
});

it("snapshots identity and metadata before queued async launch", async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const { tmp } = await import("./helpers.ts");
	const { fakeHost, fakeCtx } = await import("./fake-host.ts");
	const { registerHooks } = await import("../../src/octocode/hooks/register.ts");
	const home = tmp(),
		cwd = tmp(),
		release = path.join(home, "release");
	fs.mkdirSync(path.join(home, ".codex"));
	fs.writeFileSync(
		path.join(home, ".codex/hooks.json"),
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						hooks: Array.from({ length: 9 }, (_, i) => ({
							type: "command",
							async: true,
							timeout: 10,
							command: `cat > '${path.join(home, `${i}.json`)}'; while [ ! -e '${release}' ]; do sleep 0.02; done`,
						})),
					},
				],
			},
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	let sessionId = "original-child",
		agentType = "reviewer",
		permissionMode: "workspace" | "full" = "workspace",
		calls = 0;
	const ctx = fakeCtx({ cwd, model: { id: "original-model" } });
	ctx.sessionManager.getSessionId = () => sessionId;
	ctx.getTurnId = () => "original-turn";
	const view = registerHooks(
		fake.api,
		{ OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "1" },
		home,
		undefined,
		() => {
			calls++;
			return { agentName: "worker", agentType, permissionMode };
		},
	);
	try {
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const before = calls;
		await view.preToolUse(
			{
				toolName: "bash",
				toolCallId: "call",
				input: { command: "true" },
			} as never,
			ctx,
		);
		expect(calls - before).toBe(1);
		sessionId = "replacement-child";
		agentType = "changed";
		permissionMode = "full";
		ctx.model = { id: "changed-model" } as never;
		ctx.getTurnId = () => "changed-turn";
		fs.writeFileSync(release, "");
		const output = path.join(home, "8.json");
		let captured: unknown;
		for (let i = 0; i < 200; i++) {
			try {
				captured = JSON.parse(fs.readFileSync(output, "utf8"));
				break;
			} catch (error) {
				if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(captured).toMatchObject({
			agent_id: "original-child",
			agent_type: "reviewer",
			session_id: "original-child",
			model: "original-model",
			turn_id: "original-turn",
			permission_mode: "default",
		});
	} finally {
		fs.writeFileSync(release, "");
		await fake.fire("session_shutdown", { reason: "quit" }, ctx);
	}
}, 10000);

it.each(["claude", "codex"] as const)("carries %s child identity through both compaction owners", async (protocol) => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const { tmp } = await import("./helpers.ts");
	const { fakeHost, fakeCtx } = await import("./fake-host.ts");
	const { registerHooks } = await import("../../src/octocode/hooks/register.ts");
	const home = tmp(),
		cwd = tmp();
	const config = path.join(home, protocol === "codex" ? ".codex/hooks.json" : ".claude/settings.json");
	fs.mkdirSync(path.dirname(config), { recursive: true });
	fs.writeFileSync(
		config,
		JSON.stringify({
			hooks: Object.fromEntries(
				["PreCompact", "PostCompact"].map((event) => [
					event,
					[
						{
							hooks: [
								{
									type: "command",
									command: `cat > '${path.join(home, event)}'`,
								},
							],
						},
					],
				]),
			),
		}),
	);
	const fake = fakeHost(HOOK_SETTINGS);
	const ctx = fakeCtx({ cwd, model: { id: "current-model" } });
	ctx.sessionManager.getSessionId = () => "child-session";
	ctx.sessionManager.getSessionFile = () => "/child-transcript.jsonl";
	ctx.getTurnId = () => "current-turn";
	registerHooks(
		fake.api,
		{
			OCTOCODE_SUBAGENT: "1",
			OCTOCODE_SUBAGENT_HOOKS: "1",
		},
		home,
		undefined,
		() => ({ agentName: "native-child", agentType: "reviewer" }),
	);
	try {
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await fake.fire("session_before_compact", { reason: "manual", signal: new AbortController().signal }, ctx);
		await fake.fire("session_compact", { reason: "manual", compactionEntry: { summary: "summary" } }, ctx);
		for (const event of ["PreCompact", "PostCompact"]) {
			const captured = JSON.parse(fs.readFileSync(path.join(home, event), "utf8"));
			expect(captured).toMatchObject({
				hook_event_name: event,
				agent_id: protocol === "codex" ? "child-session" : "native-child",
				agent_type: "reviewer",
				session_id: "child-session",
				transcript_path: "/child-transcript.jsonl",
				trigger: "manual",
			});
			if (protocol === "codex")
				expect(captured).toMatchObject({
					turn_id: "current-turn",
					model: "current-model",
				});
		}
	} finally {
		await fake.fire("session_shutdown", { reason: "quit" }, ctx);
	}
});
