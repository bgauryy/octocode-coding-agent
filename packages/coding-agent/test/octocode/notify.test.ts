import { resetMultiplexerCache } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeTmux, installFakeTmux } from "../../../tui/test/helpers/fake-tmux.ts";
import { titledDialog } from "../../src/octocode/shared/locks.ts";
import { agentNameOf } from "../../src/octocode/shared/agent-name.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import {
	type Notice,
	notificationSequence,
	notifyCondition,
	notifyMethod,
	registerNotify,
} from "../../src/octocode/ui/notify.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/registry.ts";
import type { ApplicationService } from "../../src/core/application/service.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/** Application ports the tests opened, disposed after each. */
const ports: ApplicationService[] = [];

/**
 * The session's application port, as the host opens it: the feature's phase reaches it (`registerPhasePort`) and the tab
 * title follows the light it shows (contract change, RFC app-state T2: the title reads the light, not its own events).
 */
function openPort(sessionId: string) {
	const open = ports.find((port) => port.sessionId === sessionId);
	if (open) return open;
	const session = { sessionId, messages: [], isStreaming: false, subscribe: () => () => {} };
	const port = getApplicationPort(session as unknown as AgentSession);
	ports.push(port);
	return port;
}

function setup(env: NodeJS.ProcessEnv, mode = "tui", hasUI = true) {
	const fake = fakeHost();
	(fake.api.session as { getName: () => string | undefined }).getName = () => undefined;
	const writes: string[] = [];
	const notices: Notice[] = [];
	let input: ((data: string) => unknown) | undefined;
	let unsubscribed = false;
	registerNotify(fake.api, { env, write: (data) => writes.push(data), onNotice: (notice) => notices.push(notice) });
	const ctx = fakeCtx({
		cwd: "/work/repo",
		mode,
		hasUI,
		ui: {
			onTerminalInput: (handler: (data: string) => unknown) => {
				input = handler;
				return () => {
					unsubscribed = true;
					return unsubscribed;
				};
			},
		} as never,
	});
	const port = openPort(ctx.sessionManager.getSessionId());
	return { fake, ctx, writes, notices, port, type: (data: string) => input?.(data), unsubscribed: () => unsubscribed };
}

const answer = (text: string, stopReason = "stop", errorMessage?: string) => ({
	messages: [
		{ role: "user", content: "q" },
		{ role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
	],
});

async function run(s: ReturnType<typeof setup>, text = "All done.\nMore", stopReason = "stop") {
	await s.fake.fire("agent_start", {}, s.ctx);
	await s.fake.fire("agent_end", answer(text, stopReason), s.ctx);
	await s.fake.fire("agent_settled", {}, s.ctx);
}

let fakeTmux: FakeTmux | undefined;
afterEach(() => {
	for (const port of ports.splice(0)) port.dispose();
	vi.useRealTimers();
	fakeTmux?.restore();
	fakeTmux = undefined;
	resetMultiplexerCache();
});

describe("notify settings", () => {
	it("reads the condition and picks a method from the terminal", () => {
		expect(notifyCondition({})).toBe("unfocused");
		expect(notifyCondition({ OCTOCODE_NOTIFY: "off" })).toBe("off");
		expect(notifyCondition({ OCTOCODE_NOTIFY: "0" })).toBe("off");
		expect(notifyCondition({ OCTOCODE_NOTIFY: "Always" })).toBe("always");
		expect(notifyMethod({ OCTOCODE_NOTIFY_METHOD: "bel", TERM_PROGRAM: "iTerm.app" })).toBe("bel");
		expect(notifyMethod({ KITTY_WINDOW_ID: "1" })).toBe("osc99");
		expect(notifyMethod({ TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
		expect(notifyMethod({ LC_TERMINAL: "iTerm2" })).toBe("osc9");
		expect(notifyMethod({ TERM_PROGRAM: "ghostty" })).toBe("osc777");
		expect(notifyMethod({ TERM_PROGRAM: "WezTerm" })).toBe("osc777");
		expect(notifyMethod({ TERM_PROGRAM: "Apple_Terminal" })).toBe("bel");
	});

	it("builds sequences without control characters, wrapped for tmux", () => {
		expect(notificationSequence("bel", "t", "b", {})).toBe("\x07");
		expect(notificationSequence("osc9", "Octocode", "done\x1b]0;evil\x07; ok\nsecond", {})).toBe(
			"\x1b]9;Octocode: done  ok\x07",
		);
		expect(notificationSequence("osc777", "Octocode;x", "body", {})).toBe("\x1b]777;notify;Octocode x;body\x07");
		expect(notificationSequence("osc99", "Octocode", "body", {})).toBe(
			"\x1b]99;i=octocode:d=0;Octocode\x1b\\\x1b]99;i=octocode:p=body;body\x1b\\",
		);
	});

	const TMUX = { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" };

	it("wraps an OSC in tmux passthrough and appends a bell fallback in the same write", () => {
		fakeTmux = installFakeTmux({ allowPassthrough: "on" });
		expect(notificationSequence("osc9", "Octocode", "b", TMUX)).toBe("\x1bPtmux;\x1b\x1b]9;Octocode: b\x07\x1b\\\x07");
		expect(notificationSequence("bel", "t", "b", TMUX)).toBe("\x07");
	});

	it("wraps the notification for allow-passthrough all, the setting that also passes hidden windows", () => {
		fakeTmux = installFakeTmux({ allowPassthrough: "all" });
		expect(notificationSequence("osc777", "Octocode", "b", TMUX)).toBe(
			"\x1bPtmux;\x1b\x1b]777;notify;Octocode;b\x07\x1b\\\x07",
		);
	});

	it("finds the terminal of a client that attaches after the session started detached", () => {
		const env = { ...TMUX, TERM_PROGRAM: "tmux" };
		fakeTmux = installFakeTmux({ clientTermtype: "", clientTermname: "", allowPassthrough: "on" });
		const start = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);
		expect(notifyMethod(env)).toBe("bel");
		fakeTmux.restore();
		// No cache reset between the two answers. "No client" is believed for 30 s, so a detached session does not run
		// the synchronous tmux query for every notification; after that a client that attached since is found.
		fakeTmux = installFakeTmux({
			clientTermtype: "ghostty 1.3.1",
			clientTermname: "xterm-ghostty",
			allowPassthrough: "on",
		});
		clock.mockReturnValue(start + 29_000);
		expect(notifyMethod(env)).toBe("bel");
		clock.mockReturnValue(start + 31_000);
		expect(notifyMethod(env)).toBe("osc777");
		clock.mockRestore();
		expect(notificationSequence(notifyMethod(env), "Octocode", "b", env).startsWith("\x1bPtmux;")).toBe(true);
	});

	it("sends only the bell inside tmux when the pane blocks passthrough or tmux cannot be asked", () => {
		fakeTmux = installFakeTmux({ allowPassthrough: "off" });
		expect(notificationSequence("osc777", "Octocode", "b", TMUX)).toBe("\x07");
		fakeTmux.restore();
		resetMultiplexerCache();
		fakeTmux = installFakeTmux({ fail: ["passthrough"] });
		expect(notificationSequence("osc99", "Octocode", "b", TMUX)).toBe("\x07");
	});

	it("picks the method from the attached tmux client instead of TERM_PROGRAM=tmux", () => {
		const cases: [string, string, string][] = [
			["kitty(0.35.2)", "xterm-kitty", "osc99"],
			["iTerm2 3.5.0", "xterm-256color", "osc9"],
			["ghostty 1.0.1", "xterm-ghostty", "osc777"],
			["WezTerm 20240203", "xterm-256color", "osc777"],
			["", "xterm-kitty", "osc99"],
			["Terminal.app", "xterm-256color", "bel"],
		];
		for (const [termtype, termname, method] of cases) {
			resetMultiplexerCache();
			const fake = installFakeTmux({ clientTermtype: termtype, clientTermname: termname });
			try {
				expect(notifyMethod({ ...TMUX, TERM_PROGRAM: "tmux" })).toBe(method);
			} finally {
				fake.restore();
			}
		}
	});

	it("keeps the override and falls back to the environment when tmux cannot name the client", () => {
		fakeTmux = installFakeTmux({ clientTermtype: "kitty(1)", clientTermname: "xterm-kitty" });
		expect(notifyMethod({ ...TMUX, OCTOCODE_NOTIFY_METHOD: "bel" })).toBe("bel");
		fakeTmux.restore();
		resetMultiplexerCache();
		fakeTmux = installFakeTmux({ fail: ["client"] });
		expect(notifyMethod({ ...TMUX, TERM_PROGRAM: "ghostty" })).toBe("osc777");
		expect(notifyMethod({ ...TMUX, TERM_PROGRAM: "tmux" })).toBe("bel");
	});
});

describe("registerNotify", () => {
	it("notifies only while the terminal is unfocused, marks the title until focus returns", async () => {
		const s = setup({ TERM_PROGRAM: "iTerm.app" });
		await s.fake.fire("session_start", {}, s.ctx);
		expect(s.writes).toEqual(["\x1b[?1004h"]);
		expect(s.ctx.ui.title).toBe("◈ Idle - repo");
		expect(s.type("\x1b[I")).toEqual({ consume: true });
		await run(s);
		expect(s.writes).toHaveLength(1);
		// Watching: the outcome is already seen.
		expect(s.ctx.ui.title).toBe("◈ Idle - repo");
		expect(s.type("\x1b[O")).toEqual({ consume: true });
		await run(s);
		expect(s.writes.at(-1)).toBe("\x1b]9;Octocode: answer ready: All done.\x07");
		expect(s.ctx.ui.title).toBe("◈🟢 Done - repo");
		s.type("\x1b[I");
		expect(s.ctx.ui.title).toBe("◈ Idle - repo");
		await s.fake.fire("session_shutdown", {}, s.ctx);
		expect(s.writes.at(-1)).toBe("\x1b[?1004l");
		expect(s.unsubscribed()).toBe(true);
	});

	it("switches focus reporting off when the process exits without a session shutdown, and drops the hook at shutdown", async () => {
		const before = new Set(process.listeners("exit"));
		const s = setup({ TERM_PROGRAM: "iTerm.app" });
		await s.fake.fire("session_start", {}, s.ctx);
		const added = process.listeners("exit").filter((listener) => !before.has(listener));
		expect(added).toHaveLength(1);
		(added[0] as () => void)();
		expect(s.writes.filter((data) => data === "\x1b[?1004l")).toHaveLength(1);
		await s.fake.fire("session_start", {}, s.ctx);
		expect(process.listeners("exit").filter((listener) => !before.has(listener))).toHaveLength(1);
		await s.fake.fire("session_shutdown", {}, s.ctx);
		expect(process.listeners("exit").filter((listener) => !before.has(listener))).toEqual([]);
		// Off: focus reporting was never turned on, so nothing to undo.
		const off = setup({ OCTOCODE_NOTIFY: "off" });
		await off.fake.fire("session_start", {}, off.ctx);
		expect(process.listeners("exit").filter((listener) => !before.has(listener))).toEqual([]);
	});

	it("skips interrupted runs, reports errors, debounces and signals dialogs", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const s = setup({ OCTOCODE_NOTIFY: "always" });
		await s.fake.fire("session_start", {}, s.ctx);
		await run(s, "stopped", "aborted");
		expect(s.writes).toEqual(["\x1b[?1004h"]);
		await s.fake.fire("agent_start", {}, s.ctx);
		await s.fake.fire("agent_end", answer("", "error", "rate limited"), s.ctx);
		await s.fake.fire("agent_settled", {}, s.ctx);
		expect(s.writes.at(-1)).toBe("\x07");
		// A dialog the user opened between runs (a `/permissions` picker) signals nothing.
		vi.advanceTimersByTime(3_000);
		await s.fake.fire("ui_prompt_start", { kind: "select", title: "Permission mode" }, s.ctx);
		expect(s.writes).toHaveLength(2);
		expect(s.notices).toEqual([]);
		await s.fake.fire("agent_start", {}, s.ctx);
		await s.fake.fire("ui_prompt_start", { kind: "select", title: "Save?", approval: true }, s.ctx);
		expect(s.writes).toHaveLength(3);
		expect(s.notices).toEqual([{ type: "permission_prompt", title: "Octocode: waiting for you", message: "Save?" }]);
		vi.advanceTimersByTime(3_000);
		await s.fake.fire("ui_prompt_start", { kind: "select" }, s.ctx);
		expect(s.writes).toHaveLength(4);
		expect(s.notices.at(-1)).toEqual({
			type: "elicitation_dialog",
			title: "Octocode: waiting for you",
			message: "A question needs your answer",
		});
		// A plain confirmation is a question, not a permission.
		vi.advanceTimersByTime(3_000);
		await s.fake.fire("ui_prompt_start", { kind: "confirm", title: "Plain?" }, s.ctx);
		expect(s.notices.at(-1)).toMatchObject({ type: "elicitation_dialog", message: "Plain?" });
		expect(s.ctx.ui.title).toBe("◈⚠️ Needs you - repo");
		// A keypress clears only a finished outcome; the run still waits on its dialog.
		s.type("x");
		expect(s.ctx.ui.title).toBe("◈⚠️ Needs you - repo");
	});

	it("signals a blocking dialog that opens while no run is active, and shows waiting in the tab", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const s = setup({ OCTOCODE_NOTIFY: "always" });
		await s.fake.fire("session_start", {}, s.ctx);
		await run(s);
		vi.advanceTimersByTime(3_000);
		const before = s.writes.length;
		await s.fake.fire("ui_prompt_start", { kind: "select", title: "Run it?", approval: true, blocking: true }, s.ctx);
		expect(s.writes.length).toBe(before + 1);
		expect(s.notices.at(-1)).toMatchObject({ type: "permission_prompt", message: "Run it?" });
		expect(s.ctx.ui.title).toBe("◈⚠️ Needs you - repo");
		await s.fake.fire("ui_prompt_end", { kind: "select" }, s.ctx);
		expect(s.ctx.ui.title).not.toContain("⚠️");
	});

	it("signals a blocking dialog nested over a dialog the user opened, and keeps waiting when that one closes first", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const s = setup({ OCTOCODE_NOTIFY: "always" });
		await s.fake.fire("session_start", {}, s.ctx);
		await run(s);
		vi.advanceTimersByTime(3_000);
		await s.fake.fire("ui_prompt_start", { id: "picker", kind: "select", title: "Permission mode" }, s.ctx);
		const before = s.notices.length;
		await s.fake.fire(
			"ui_prompt_start",
			{ id: "approval", kind: "select", title: "Run it?", approval: true, blocking: true, nested: true },
			s.ctx,
		);
		expect(s.notices.slice(before)).toEqual([
			expect.objectContaining({ type: "permission_prompt", message: "Run it?" }),
		]);
		expect(s.ctx.ui.title).toBe("◈⚠️ Needs you - repo");
		await s.fake.fire("ui_prompt_end", { id: "picker", kind: "select" }, s.ctx);
		expect(s.ctx.ui.title).toBe("◈⚠️ Needs you - repo");
		await s.fake.fire("ui_prompt_end", { id: "approval", kind: "select", nested: true }, s.ctx);
		expect(s.ctx.ui.title).not.toContain("⚠️");
	});

	it("counts in the tab the agents the footer counts", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const s = setup({ OCTOCODE_NOTIFY: "off" });
		const work = runningWorkOf(s.fake.api);
		await s.fake.fire("session_start", {}, s.ctx);
		await s.fake.fire("agent_start", {}, s.ctx);
		work.setBackground(["general-1a2b"]);
		work.setAgents(3);
		vi.advanceTimersByTime(300);
		expect(s.ctx.ui.title).toBe("◈⠋ Thinking - repo · 3 agents");
	});

	it("shows thinking, a running tool, and the outcome until a keypress; coalesces quick tool swaps", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const s = setup({ OCTOCODE_NOTIFY: "off" });
		const titles: string[] = [];
		const setTitle = s.ctx.ui.setTitle.bind(s.ctx.ui);
		s.ctx.ui.setTitle = (title: string) => {
			titles.push(title);
			setTitle(title);
		};
		await s.fake.fire("session_start", {}, s.ctx);
		await s.fake.fire("agent_start", {}, s.ctx);
		expect(s.ctx.ui.title).toBe("◈⠋ Thinking - repo");
		// A tool that finishes within the window never reaches the tab.
		await s.fake.fire("tool_execution_start", { toolCallId: "a", toolName: "read" }, s.ctx);
		await s.fake.fire("tool_execution_end", { toolCallId: "a", toolName: "read" }, s.ctx);
		vi.advanceTimersByTime(300);
		expect(titles).toEqual(["◈ Idle - repo", "◈⠋ Thinking - repo"]);
		await s.fake.fire("tool_execution_start", { toolCallId: "b", toolName: "bash" }, s.ctx);
		vi.advanceTimersByTime(300);
		expect(s.ctx.ui.title).toBe("◈⠋ Running - repo");
		await s.fake.fire("tool_execution_end", { toolCallId: "b", toolName: "bash" }, s.ctx);
		await s.fake.fire("agent_end", answer("", "error", "rate limited"), s.ctx);
		// The title reads the light, whose failed job comes from the settled run's outcome.
		await s.fake.fire(
			"agent_settled",
			{ aborted: false, outcome: { status: "failed", errorMessage: "rate limited" } },
			s.ctx,
		);
		expect(s.ctx.ui.title).toBe("◈🔴 Error - repo");
		s.type("k");
		expect(s.ctx.ui.title).toBe("◈ Idle - repo");
		// An interrupted run goes straight back to idle.
		await s.fake.fire("agent_start", {}, s.ctx);
		await s.fake.fire("agent_end", answer("partial", "aborted"), s.ctx);
		await s.fake.fire("agent_settled", { aborted: true }, s.ctx);
		expect(s.ctx.ui.title).toBe("◈ Idle - repo");
		// A dialog opened between runs is the user's own and changes nothing.
		await s.fake.fire("ui_prompt_start", { kind: "select" }, s.ctx);
		expect(s.ctx.ui.title).toBe("◈ Idle - repo");
		await s.fake.fire("ui_prompt_end", { kind: "select" }, s.ctx);
	});

	it("shows waiting while background subagents or jobs run after the main run, then the outcome", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const s = setup({ OCTOCODE_NOTIFY: "off" });
		const work = runningWorkOf(s.fake.api);
		await s.fake.fire("session_start", {}, s.ctx);
		await s.fake.fire("agent_start", {}, s.ctx);
		work.setBackground(["general-1a2b"]);
		await s.fake.fire("agent_end", answer("Started a child"), s.ctx);
		await s.fake.fire("agent_settled", { aborted: false }, s.ctx);
		vi.advanceTimersByTime(300);
		expect(s.ctx.ui.title).toBe("◈⏳ Waiting - repo · 1 agent");
		s.type("k"); // seeing the tab does not end the work
		work.set("bash", [{ kind: "bash", id: "bash-1", title: "build" }]);
		work.setBackground([]);
		vi.advanceTimersByTime(300);
		expect(s.ctx.ui.title).toBe("◈⏳ Waiting - repo");
		work.set("bash", []);
		expect(s.ctx.ui.title).toBe("◈🟢 Done - repo");
		s.type("k");
		expect(s.ctx.ui.title).toBe("◈ Idle - repo");
	});

	it("leaves no busy mark on the tab after shutdown while background work still runs", async () => {
		const s = setup({ OCTOCODE_NOTIFY: "off" });
		await s.fake.fire("session_start", {}, s.ctx);
		runningWorkOf(s.fake.api).set("bash", [{ kind: "bash", id: "bash-1", title: "dev server" }]);
		expect(s.ctx.ui.title).toBe("◈⏳ Waiting - repo");
		await s.fake.fire("session_shutdown", {}, s.ctx);
		expect(s.ctx.ui.title).toBe("repo");
	});

	it("never shows Done while a subagent still runs, even when the session's phase is final", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const s = setup({ OCTOCODE_NOTIFY: "off" });
		const work = runningWorkOf(s.fake.api);
		await s.fake.fire("session_start", {}, s.ctx);
		await s.fake.fire("agent_start", {}, s.ctx);
		await s.fake.fire("agent_end", answer("done for now"), s.ctx);
		await s.fake.fire("agent_settled", { aborted: false }, s.ctx);
		expect(s.ctx.ui.title).toBe("◈🟢 Done - repo");
		work.setBackground(["a", "b"]);
		expect(s.ctx.ui.title).toBe("◈⏳ Waiting - repo · 2 agents");
		work.setBackground(["b"]); // one of two finished: still waiting
		expect(s.ctx.ui.title).toBe("◈⏳ Waiting - repo · 1 agent");
		work.setBackground([]);
		expect(s.ctx.ui.title).toBe("◈🟢 Done - repo");
	});

	it("names the agent in the tab as soon as it joins, rejoins or leaves the team, keeping the state", async () => {
		const s = setup({ OCTOCODE_NOTIFY: "off" });
		await s.fake.fire("session_start", {}, s.ctx);
		const name = agentNameOf(s.fake.api);
		name.set("shy-barnacle");
		expect(s.ctx.ui.title).toBe("◈ shy-barnacle Idle - repo");
		await s.fake.fire("agent_start", {}, s.ctx);
		name.set("shy-barnacle-2");
		expect(s.ctx.ui.title).toBe("◈⠋ shy-barnacle-2 Thinking - repo");
		name.set(undefined);
		expect(s.ctx.ui.title).toBe("◈⠋ Thinking - repo");
		await s.fake.fire("session_shutdown", {}, s.ctx);
		name.set("late");
		expect(s.ctx.ui.title).toBe("repo");
	});

	it("describes the session by its name, else its first prompt, including one resumed from the file", async () => {
		const s = setup({ OCTOCODE_NOTIFY: "off" });
		await s.fake.fire("session_start", {}, s.ctx);
		await s.fake.fire("before_agent_start", { messageType: "user", prompt: "fix the\nlogin bug" }, s.ctx);
		await s.fake.fire("agent_start", {}, s.ctx);
		expect(s.ctx.ui.title).toBe("◈⠋ Thinking - fix the login bug · repo");
		await s.fake.fire("before_agent_start", { messageType: "user", prompt: "and the tests" }, s.ctx);
		(s.fake.api.session as { getName: () => string }).getName = () => "login fix";
		await s.fake.fire("session_info_changed", {}, s.ctx);
		expect(s.ctx.ui.title).toBe("◈⠋ Thinking - login fix · repo");

		const resumed = setup({ OCTOCODE_NOTIFY: "off" });
		const entries = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "earlier ask" }] } }];
		(resumed.ctx as unknown as { sessionManager: { getEntries: () => unknown[] } }).sessionManager.getEntries = () =>
			entries;
		await resumed.fake.fire("session_start", {}, resumed.ctx);
		expect(resumed.ctx.ui.title).toBe("◈ Idle - earlier ask · repo");
	});

	it("fires the idle_prompt hook after a minute without input, and none after a keypress", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const s = setup({ OCTOCODE_NOTIFY: "off" });
		await s.fake.fire("session_start", {}, s.ctx);
		expect(s.writes).toEqual([]);
		await run(s, "Answer");
		vi.advanceTimersByTime(60_000);
		expect(s.notices).toEqual([
			{ type: "idle_prompt", title: "Octocode is waiting for your input", message: "Answer" },
		]);
		await run(s, "Second");
		s.type("k");
		vi.advanceTimersByTime(60_000);
		expect(s.notices).toHaveLength(1);
		expect(s.writes).toEqual([]);
	});

	it("without focus reports, notifies after a long run with no keypress", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const s = setup({});
		await s.fake.fire("session_start", {}, s.ctx);
		await run(s, "quick");
		expect(s.writes).toHaveLength(1);
		await s.fake.fire("agent_start", {}, s.ctx);
		vi.advanceTimersByTime(31_000);
		await s.fake.fire("agent_end", answer("slow"), s.ctx);
		await s.fake.fire("agent_settled", {}, s.ctx);
		expect(s.writes.at(-1)).toBe("\x07");
	});

	it("stays out of print and JSON modes; in RPC fires the hooks but writes nothing to the terminal", async () => {
		const s = setup({ OCTOCODE_NOTIFY: "always" }, "json", false);
		await s.fake.fire("session_start", {}, s.ctx);
		await run(s);
		await s.fake.fire("ui_prompt_start", { kind: "confirm", title: "x" }, s.ctx);
		await s.fake.fire("session_shutdown", {}, s.ctx);
		expect(s.writes).toEqual([]);
		expect(s.notices).toEqual([]);

		vi.useFakeTimers({ now: 1_000_000 });
		const rpc = setup({ OCTOCODE_NOTIFY: "always" }, "rpc");
		await rpc.fake.fire("session_start", {}, rpc.ctx);
		await rpc.fake.fire("agent_start", {}, rpc.ctx);
		await rpc.fake.fire("ui_prompt_start", { kind: "select", title: "Run it?", approval: true }, rpc.ctx);
		await rpc.fake.fire("agent_end", answer("Done"), rpc.ctx);
		await rpc.fake.fire("agent_settled", {}, rpc.ctx);
		vi.advanceTimersByTime(60_000);
		expect(rpc.notices.map((notice) => notice.type)).toEqual(["permission_prompt", "idle_prompt"]);
		expect(rpc.writes).toEqual([]);
		expect(rpc.ctx.ui.title).toBeUndefined();
	});

	it("names a custom dialog by the title its opener gave it", async () => {
		const s = setup({ OCTOCODE_NOTIFY: "off" });
		await s.fake.fire("session_start", {}, s.ctx);
		await s.fake.fire("agent_start", {}, s.ctx);
		let close!: () => void;
		const open = titledDialog(
			"Which database?",
			() =>
				new Promise<void>((resolve) => {
					close = resolve;
					return close;
				}),
		);
		await s.fake.fire("ui_prompt_start", { kind: "custom" }, s.ctx);
		close();
		await open;
		await s.fake.fire("ui_prompt_start", { kind: "custom" }, s.ctx);
		expect(s.notices.map((notice) => notice.message)).toEqual(["Which database?", "A question needs your answer"]);
	});
});
