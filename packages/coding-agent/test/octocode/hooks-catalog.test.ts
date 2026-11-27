import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureToolInvocation } from "../../src/core/tools/tool-invocation.ts";
import {
	HOOK_CATALOG,
	HOOK_EVENTS,
	profileEvents,
	profileSupport,
	UPSTREAM_ONLY_EVENTS,
	type HookEvent,
	type HookHandlerType,
	type HookProtocol,
} from "../../src/octocode/hooks/catalog.ts";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { hookEventsReport } from "../../src/octocode/hooks/register/report.ts";
import type { HooksView } from "../../src/octocode/hooks/register/types.ts";
import { monitorLedgerOf } from "../../src/octocode/monitor/ledger.ts";
import { AGENT_CHAIN_CHANNEL } from "../../src/octocode/shared/agent-chain.ts";
import { AGENT_LIFECYCLE_CHANNEL } from "../../src/octocode/shared/agent-lifecycle.ts";
import { BACKLOG_CHANGE_CHANNEL } from "../../src/octocode/shared/backlog-change.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { approveFixtureHooks } from "./guard-helpers.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

afterEach(() => vi.unstubAllEnvs());

const PROTOCOLS: HookProtocol[] = ["octocode", "claude", "codex"];
const HANDLERS: Record<HookHandlerType, Record<string, unknown>> = {
	command: { type: "command", command: "true" },
	http: { type: "http", url: "https://hooks.example.test/check" },
	prompt: { type: "prompt", prompt: "Check $ARGUMENTS" },
	mcp_tool: { type: "mcp_tool", server: "policy", tool: "check" },
};

const parse = (protocol: HookProtocol, event: string, handler: Record<string, unknown>) => {
	const errors: string[] = [];
	const config = parseHooks(
		{ hooks: { [event]: [{ hooks: [handler] }] } },
		"fixture",
		undefined,
		errors,
		undefined,
		protocol,
	);
	const loaded = (config as Record<string, Array<{ hooks: unknown[] }>>)[event] ?? [];
	return { loaded: loaded.flatMap((group) => group.hooks).length, errors };
};

describe("hook catalog", () => {
	it("is the parser's allowlist: every profile accepts exactly the events and handler types the catalog declares", () => {
		const mismatches: string[] = [];
		for (const protocol of PROTOCOLS)
			for (const event of HOOK_EVENTS)
				for (const [type, handler] of Object.entries(HANDLERS) as Array<[HookHandlerType, Record<string, unknown>]>) {
					const support = profileSupport(protocol, event);
					const expected = support !== undefined && (type === "command" || support.handlers.includes(type));
					const { loaded } = parse(protocol, event, handler);
					if (loaded > 0 !== expected) mismatches.push(`${protocol} ${event} ${type}: expected ${expected}`);
				}
		expect(mismatches).toEqual([]);
	});

	it("applies each profile's default and maximum timeout", () => {
		for (const protocol of PROTOCOLS)
			for (const event of profileEvents(protocol)) {
				const support = profileSupport(protocol, event)!;
				const config = parseHooks(
					{ hooks: { [event]: [{ hooks: [{ type: "command", command: "true", timeout: 10_000 }] }] } },
					"fixture",
					undefined,
					[],
					undefined,
					protocol,
				);
				const [hook] = (config as Record<string, Array<{ hooks: Array<{ timeoutMs: number }> }>>)[event][0].hooks;
				expect(hook.timeoutMs, `${protocol} ${event}`).toBe((support.maxTimeout ?? 600) * 1000);
			}
	});

	it("reports upstream events Octocode lacks as not implemented, distinct from unknown names", () => {
		for (const protocol of ["claude", "codex"] as const)
			for (const event of UPSTREAM_ONLY_EVENTS[protocol]) {
				expect(Object.hasOwn(HOOK_CATALOG, event), event).toBe(false);
				expect(parse(protocol, event, HANDLERS.command).errors.join()).toContain("not implemented in Octocode yet");
			}
		expect(parse("claude", "NoSuchEvent", HANDLERS.command).errors.join()).toContain(
			"unsupported hook event NoSuchEvent",
		);
	});

	it("drives /hooks events", () => {
		const report = hookEventsReport();
		for (const event of HOOK_EVENTS) expect(report).toContain(event);
		for (const event of UPSTREAM_ONLY_EVENTS.claude) expect(report).toContain(event);
		expect(report).toContain(`claude: ${profileEvents("claude").length} events`);
	});
});

const CHILD_ENV = { OCTOCODE_SUBAGENT: "1", OCTOCODE_SUBAGENT_HOOKS: "all", OCTOCODE_PARENT_SESSION: "parent-session" };
const BASH = { toolName: "bash", toolCallId: "call-1", input: { command: "ls" } };
const TEXT = [{ type: "text", text: "ok" }];
const MESSAGE = { channel: "internal", from: "a", to: "b", text: "hi", id: "m-1" } as const;
const settle = (outcome: string) => ({
	outcome,
	entries: [],
	continue: false,
	context: { llmMessages: [{ role: "assistant", content: TEXT }] },
});
const lifecycle = (kind: "on" | "off") => ({
	seq: 1,
	kind,
	agent: "kelp",
	role: "general",
	parent: null,
	time: "2026-11-15T10:00:00.000Z",
	data: {},
	...(kind === "off" ? { reason: "completed" } : {}),
});
const backlogChange = {
	change: { id: 1, ref: "B7", kind: "created", by: "me", paths: [], beforePaths: [] },
	own: true,
};

interface Session {
	hooks: HooksView;
	ctx: ReturnType<typeof fakeCtx>;
	fire(event: string, payload: unknown): Promise<unknown>;
	emit(channel: string, value: unknown): void;
	api: object;
}

/**
 * What raises each event in a session: the bus event, channel notice or view call its dispatcher listens to. `start`
 * marks the one the session start itself raises, `child` the ones only a subagent running every hook raises.
 */
const TRIGGERS: Record<HookEvent, { child?: true; start?: true; raise(s: Session): unknown }> = {
	PreToolUse: { raise: (s) => s.hooks.preToolUse({ ...BASH } as never, s.ctx) },
	PermissionRequest: {
		raise: (s) =>
			s.hooks.permissionRequest(
				captureToolInvocation(BASH.toolCallId, BASH.toolName, BASH.input)!,
				s.ctx,
				new AbortController().signal,
			),
	},
	PostToolUse: { raise: (s) => s.fire("tool_result", { ...BASH, content: TEXT, isError: false, details: {} }) },
	PostToolUseFailure: { raise: (s) => s.fire("tool_result", { ...BASH, content: TEXT, isError: true, details: {} }) },
	PostToolBatch: {
		raise: (s) =>
			s.fire("turn_end", {
				entries: [],
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: BASH.toolCallId, name: BASH.toolName, arguments: BASH.input }],
				},
				toolResults: [{ toolCallId: BASH.toolCallId, content: TEXT }],
			}),
	},
	SessionStart: { start: true, raise: () => undefined },
	SubagentStart: { child: true, raise: (s) => s.fire("before_agent_start", {}) },
	SubagentStop: { child: true, raise: (s) => s.fire("agent_before_settle", settle("completed")) },
	Interrupt: {
		raise: (s) =>
			s.fire("agent_interrupted", {
				model: { id: "model-1" },
				cwd: s.ctx.cwd,
				sessionId: "session-test",
				turnId: "turn-1",
			}),
	},
	SessionEnd: { raise: (s) => s.fire("session_shutdown", { reason: "quit" }) },
	AgentOn: { raise: (s) => s.emit(AGENT_LIFECYCLE_CHANNEL, lifecycle("on")) },
	AgentQueued: {
		raise: (s) => s.emit(AGENT_CHAIN_CHANNEL, { kind: "queued", agent: "kelp", role: "general", after: ["B12"] }),
	},
	AgentOff: { raise: (s) => s.emit(AGENT_LIFECYCLE_CHANNEL, lifecycle("off")) },
	TaskCreated: { raise: (s) => s.emit(BACKLOG_CHANGE_CHANNEL, backlogChange) },
	TaskCompleted: { raise: (s) => s.hooks.taskCompleted({ ref: "B7", title: "T", goal: "g", change: "done" }, s.ctx) },
	BacklogChange: { raise: (s) => s.emit(BACKLOG_CHANGE_CHANNEL, backlogChange) },
	MonitorAlert: { raise: (s) => monitorLedgerOf(s.api).record({ rule: "job", value: 16, threshold: 15 }, true) },
	UserPromptSubmit: { raise: (s) => s.fire("input", { text: "hello" }) },
	PreCompact: { raise: (s) => s.fire("session_before_compact", { reason: "manual" }) },
	PostCompact: {
		raise: (s) => s.fire("session_compact", { reason: "manual", compactionEntry: { summary: "summary" } }),
	},
	Stop: { raise: (s) => s.fire("agent_before_settle", settle("completed")) },
	StopFailure: { raise: (s) => s.fire("agent_before_settle", settle("error")) },
	Notification: { raise: (s) => s.hooks.notification({ type: "idle_prompt", message: "idle" }, s.ctx) },
	PreMessageSend: { raise: (s) => s.hooks.messageSend({ ...MESSAGE, direction: "outbound" }, s.ctx) },
	PostMessageReceive: { raise: (s) => s.hooks.messageReceive({ ...MESSAGE, direction: "inbound" }, s.ctx) },
};

describe("hook dispatchers", () => {
	const PROFILE_FILES: Record<HookProtocol, string[]> = {
		octocode: [".octocode", "hooks.json"],
		claude: [".claude", "settings.json"],
		codex: [".codex", "hooks.json"],
	};

	it("has a trigger for every event the catalog lists", () => {
		expect(Object.keys(TRIGGERS).sort()).toEqual([...HOOK_EVENTS].sort());
	});

	it.each(Object.entries(TRIGGERS))(
		"runs a configured %s hook when the session raises the event",
		async (name, trigger) => {
			const event = name as HookEvent;
			const home = tmp("hook-catalog-home-");
			vi.stubEnv("OCTOCODE_HOME", path.join(home, ".octocode"));
			const marker = path.join(home, "ran");
			// The same marker hook in every profile that accepts the event; each signs with its profile.
			const profiles = PROTOCOLS.filter((protocol) => profileSupport(protocol, event));
			for (const protocol of profiles) {
				const file = path.join(home, ...PROFILE_FILES[protocol]);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				const command = `echo ${protocol} >> ${JSON.stringify(marker)}`;
				fs.writeFileSync(file, JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command }] }] } }));
			}
			const listeners = new Map<string, Array<(value: unknown) => void>>();
			const fake = fakeHost(HOOK_SETTINGS);
			fake.flat.events = {
				on: (channel: string, listener: (value: unknown) => void) => {
					listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
					return () => undefined;
				},
				emit: (channel: string, value: unknown) => listeners.get(channel)?.forEach((listener) => listener(value)),
			};
			const hooks = registerHooks(fake.api, {
				env: trigger.child ? CHILD_ENV : {},
				home,
				metadata: () => ({ permissionMode: "manual", agentType: "general" }),
			});
			const ctx = fakeCtx({ cwd: tmp("hook-catalog-cwd-"), hasUI: false, model: { id: "model-1" } });
			Object.assign(ctx, { getTurnId: () => "turn-1" });
			approveFixtureHooks(ctx.cwd, home);
			const session: Session = {
				hooks,
				ctx,
				api: fake.api,
				fire: (bus, payload) => fake.fire(bus, payload, ctx),
				emit: (channel, value) => fake.api.channels.emit(channel, value),
			};
			expect(hooks.report(ctx.cwd)).not.toContain(event);
			await session.fire("session_start", { reason: "startup" });
			expect(hooks.report(ctx.cwd), "the hook loaded").toContain(`  ${event} [*] echo`);
			// Nothing but the event's own trigger runs its hook (the session start is SessionStart's).
			if (!trigger.start) expect(fs.existsSync(marker)).toBe(false);
			await trigger.raise(session);
			await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 5_000 });
			const ran = fs.readFileSync(marker, "utf8").trim().split("\n");
			expect(profiles).toEqual(expect.arrayContaining(ran));
			if (event !== "SessionEnd") await session.fire("session_shutdown", { reason: "quit" });
		},
		20_000,
	);
});
