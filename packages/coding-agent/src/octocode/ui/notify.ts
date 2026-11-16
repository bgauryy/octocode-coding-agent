import {
	hasTmuxSession,
	TitlePainter,
	tmuxClientTerminalNames,
	tmuxPaneAllowsPassthrough,
	wrapTmuxPassthrough,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { NOTIFY_ENV, NOTIFY_METHOD_ENV } from "@octocodeai/octocode-common/env";
import { promptTitle } from "../shared/locks.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import { beginRun, getRunClock, lastRunStart, settleRun } from "../../utils/run-clock.ts";
import { clipText, contentText, firstLine } from "../shared/util.ts";
import { plainTitle, TitleTracker, terminalTitle } from "./terminal-title.ts";
import { registerPresentWarming } from "./present-warming.ts";

/**
 * "Answer ready" and "waiting for you" signals for a terminal in the background: a desktop notification (OSC 9, OSC 777 or Kitty's OSC 99, else
 * the bell). The terminal title carries the session state, `🐙⠋ Running - fix login · repo · 2 agents`: thinking and running animate,
 * then `⚠️` needs you, `🟢` done or `🔴` error until the user is back (focus returns or a key is pressed), else idle.
 *
 * This enables focus reports (CSI ?1004) and reads `ESC [ I` / `ESC [ O` in both TUI modes. A terminal without focus
 * reports leaves focus unknown; then it falls back to idleness: a run that took long while the user typed nothing.
 *
 * The terminal signals are the TUI's own. The Notification hooks (user scripts) fire in any mode with a UI, RPC
 * included, where a client shows the dialogs.
 */

type NotifyCondition = "off" | "unfocused" | "always";
type NotifyMethod = "osc9" | "osc777" | "osc99" | "bel";
type Focus = "unknown" | "focused" | "unfocused";

/** What fired a notice, in the vocabulary of the Notification hook. */
type NoticeType = "idle_prompt" | "permission_prompt" | "elicitation_dialog";

export interface Notice {
	type: NoticeType;
	title: string;
	message: string;
}

const FOCUS_ON = "\x1b[?1004h";
const FOCUS_OFF = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BEL = "\x07";
/** Without focus reports: a run this long with no keypress counts as "the user stepped away". */
const AWAY_MS = 30_000;
/** No two notifications within this window (a prompt right after an answer, back-to-back dialogs). */
const DEBOUNCE_MS = 3_000;
/** An answer still unread after this long fires the `idle_prompt` Notification hook. */
const IDLE_PROMPT_MS = 60_000;
const BODY_MAX = 120;

export function notifyCondition(env: NodeJS.ProcessEnv = process.env): NotifyCondition {
	const value = env[NOTIFY_ENV]?.trim().toLowerCase();
	if (value === "off" || value === "0" || value === "false" || value === "no") return "off";
	if (value === "always") return "always";
	return "unfocused";
}

/** The method for a terminal's name (an `$TERM_PROGRAM`, an XTVERSION name or a `$TERM`), or undefined when unknown. */
function methodForTerminal(name: string): NotifyMethod | undefined {
	if (name.includes("kitty")) return "osc99";
	if (name.includes("iterm")) return "osc9";
	if (name.includes("ghostty") || name.includes("wezterm")) return "osc777";
	return undefined;
}

/**
 * The escape the terminal understands, from `OCTOCODE_NOTIFY_METHOD` or the terminal itself. Inside tmux the terminal's
 * own variables describe the pane (`TERM_PROGRAM=tmux`) or a stale first client, so the attached client's name decides.
 */
export function notifyMethod(env: NodeJS.ProcessEnv = process.env): NotifyMethod {
	const chosen = env[NOTIFY_METHOD_ENV]?.trim().toLowerCase();
	if (chosen === "osc9" || chosen === "osc777" || chosen === "osc99" || chosen === "bel") return chosen;
	if (hasTmuxSession(env)) {
		for (const name of tmuxClientTerminalNames(env)) {
			const method = methodForTerminal(name);
			if (method) return method;
		}
	}
	const program = `${env.TERM_PROGRAM ?? ""} ${env.LC_TERMINAL ?? ""}`.toLowerCase();
	if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return "osc99";
	if (program.includes("iterm")) return "osc9";
	if (program.includes("ghostty") || env.GHOSTTY_RESOURCES_DIR || program.includes("wezterm")) return "osc777";
	return "bel";
}

/** Text safe inside an OSC string: no control characters, no `;` (a field separator for OSC 777 / 99). */
function oscText(text: string): string {
	return clipText(
		firstLine(sanitizeTerminalText(text))
			.replace(/[\x00-\x1f\x7f-\x9f;]/g, " ")
			.trim(),
		BODY_MAX,
	);
}

/**
 * The bytes for one notification. Inside tmux an OSC goes through tmux's passthrough, and only when the pane allows it
 * (tmux drops a bare OSC 9, 99 or 777); a bell follows in the same write, so a dropped envelope still flags the pane.
 */
export function notificationSequence(
	method: NotifyMethod,
	title: string,
	body: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const t = oscText(title);
	const b = oscText(body);
	let osc: string;
	switch (method) {
		case "bel":
			return BEL;
		case "osc9":
			osc = `\x1b]9;${t}: ${b}${BEL}`;
			break;
		case "osc777":
			osc = `\x1b]777;notify;${t};${b}${BEL}`;
			break;
		case "osc99":
			osc = `\x1b]99;i=octocode:d=0;${t}\x1b\\\x1b]99;i=octocode:p=body;${b}\x1b\\`;
			break;
	}
	if (!hasTmuxSession(env)) return osc;
	return (tmuxPaneAllowsPassthrough(env) ? wrapTmuxPassthrough(osc) : "") + BEL;
}

interface NotifyOptions {
	/**
	 * Notices for the Notification hooks, whether or not the terminal was signalled: a dialog when it opens, an unread
	 * answer after a minute without input (the `idle_prompt` notice).
	 */
	onNotice?: (notice: Notice, ctx: ExtensionContext) => void;
	env?: NodeJS.ProcessEnv;
	write?: (data: string) => void;
}

/** Registers the notifier for the root session; it follows Octocode's events, and the presence it sees steers cache warming. */
export function registerNotify(api: ExtensionAPI, options: NotifyOptions = {}): void {
	const env = options.env ?? process.env;
	const write =
		options.write ??
		((data: string) => {
			process.stdout.write(data);
			return undefined;
		});
	const condition = notifyCondition(env);
	let ctx: ExtensionContext | undefined;
	let focus: Focus = "unknown";
	let lastInputAt = Date.now();
	let lastNoticeAt = 0;
	const title = new TitleTracker();
	const work = runningWorkOf(api);
	/** The first prompt of the session, its description in the tab until it has a name. */
	let firstPrompt: string | undefined;
	/** Outcome of the latest response, applied to the title when the run settles. */
	let outcome: "idle" | "done" | "failed" = "idle";
	let unsubscribe: (() => void) | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let lastAnswer = "";
	// Focus reporting outlives the process unless turned off: a crash or a terminal hand-off without session_shutdown
	// would leave the shell printing ESC[I / ESC[O. Exit handlers run synchronously, so the write still lands.
	const focusOffAtExit = () => write(FOCUS_OFF);
	const dropExitHook = () => process.removeListener("exit", focusOffAtExit);

	const tui = (current: ExtensionContext | undefined): current is ExtensionContext =>
		current?.mode === "tui" && current.hasUI;
	const painter = new TitlePainter(
		{
			state: () => title.state,
			target: () => (tui(ctx) ? { cwd: ctx.cwd, setTitle: (text) => ctx?.ui.setTitle(text) } : undefined),
			description: () => api.getSessionName()?.trim() || firstPrompt,
			agents: () => work.agents() ?? work.background().length,
		},
		{ full: terminalTitle, plain: plainTitle },
	);
	const paintTitle = (force = false) => painter.paint(force);
	/** The user is back: drop a finished or failed mark. */
	const seen = () => {
		title.seen();
		paintTitle();
	};
	const clearIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	/** The user is (probably) not looking: unfocused, or no focus reports and a long run with no keypress. */
	const away = (now: number): boolean => {
		if (condition === "always") return true;
		if (focus !== "unknown") return focus === "unfocused";
		const runStartedAt = lastRunStart();
		return runStartedAt !== undefined && now - runStartedAt >= AWAY_MS && now - lastInputAt >= AWAY_MS;
	};
	const fire = (notice: Notice, hook: boolean) => {
		if (!ctx?.hasUI) return;
		if (hook) options.onNotice?.(notice, ctx);
		if (!tui(ctx)) return;
		const now = Date.now();
		if (condition === "off" || !away(now) || now - lastNoticeAt < DEBOUNCE_MS) return;
		lastNoticeAt = now;
		write(notificationSequence(notifyMethod(env), notice.title, notice.message, env));
	};

	// Background subagents and jobs outlive the run: the tab says finished only once the last of them ends.
	work.subscribe(() => {
		title.setBackground(work.busy());
		paintTitle();
	});

	api.on("session_start", async (_event, current) => {
		unsubscribe?.();
		unsubscribe = undefined;
		clearIdle();
		painter.reset();
		ctx = current;
		title.reset();
		outcome = "idle";
		firstPrompt = firstPromptOf(current);
		if (!tui(current)) return;
		paintTitle(true);
		unsubscribe = current.ui.onTerminalInput((data) => {
			if (data === FOCUS_IN || data === FOCUS_OUT) {
				focus = data === FOCUS_IN ? "focused" : "unfocused";
				if (focus === "focused") seen();
				return { consume: true };
			}
			lastInputAt = Date.now();
			clearIdle();
			seen();
			return undefined;
		});
		if (condition !== "off") {
			write(FOCUS_ON);
			dropExitHook();
			process.once("exit", focusOffAtExit);
		}
	});
	// The host rewrites the plain title on a rename; put the state mark back.
	api.on("session_info_changed", async () => paintTitle(true));
	api.on("before_agent_start", async (event) => {
		if (!firstPrompt && event.messageType === "user") firstPrompt = event.prompt.trim() || undefined;
		return undefined;
	});
	api.on("session_shutdown", async () => {
		clearIdle();
		unsubscribe?.();
		unsubscribe = undefined;
		dropExitHook();
		if (tui(ctx) && condition !== "off") write(FOCUS_OFF);
		title.reset();
		// Work still running after exit is no longer this tab's: leave the plain title, without a state.
		title.setBackground(0);
		painter.leave();
		ctx = undefined;
	});
	api.on("agent_start", async () => {
		beginRun(Date.now());
		lastAnswer = "";
		outcome = "idle";
		clearIdle();
		title.start();
		paintTitle();
	});
	api.on("tool_execution_start", async (event) => {
		title.toolStart(event.toolCallId);
		paintTitle();
	});
	api.on("tool_execution_end", async (event) => {
		title.toolEnd(event.toolCallId);
		paintTitle();
	});
	api.on("agent_end", async (event) => {
		type Message = (typeof event.messages)[number];
		const last = [...event.messages]
			.reverse()
			.find((message): message is Extract<Message, { role: "assistant" }> => message.role === "assistant");
		// An interrupted run (Esc) means the user is right here; an error is worth a notice.
		if (!last) return;
		outcome = last.stopReason === "aborted" ? "idle" : last.stopReason === "error" ? "failed" : "done";
		if (last.stopReason === "aborted") return;
		lastAnswer =
			last.stopReason === "error"
				? `Failed: ${last.errorMessage ?? "the run stopped with an error"}`
				: contentText(last.content) || "Ready for input";
	});
	api.on("agent_settled", async (event, next) => {
		const answer = lastAnswer;
		lastAnswer = "";
		title.settle(event.aborted ? "idle" : outcome);
		outcome = "idle";
		// Someone watching the terminal has already seen the outcome.
		if (focus === "focused") title.seen();
		paintTitle();
		if (ctx?.hasUI && answer) {
			fire({ type: "idle_prompt", title: "Octocode: answer ready", message: answer }, false);
			const current = ctx;
			clearIdle();
			idleTimer = setTimeout(
				() =>
					options.onNotice?.(
						{ type: "idle_prompt", title: "Octocode is waiting for your input", message: answer },
						current,
					),
				IDLE_PROMPT_MS,
			);
			idleTimer.unref?.();
		}
		settleRun(Date.now(), next.hasPendingMessages() && !event.aborted);
	});
	api.on("ui_prompt_end", async (event) => {
		title.promptEnd(event.id);
		paintTitle();
	});
	api.on("ui_prompt_start", async (event) => {
		const firstBlocking = title.promptStart(event.id, event.blocking === true);
		paintTitle();
		// A dialog over another is the same wait: one notification. A blocking one over a dialog the user opened (such as
		// the `/permissions` picker) is a new wait.
		if (event.nested && !firstBlocking) return;
		// Only the agent's dialogs: one the user opened (such as a `/permissions` picker) needs no call back. A blocking
		// one (a background subagent's approval) still matters after the run settled.
		if (getRunClock() === undefined && event.blocking !== true) return;
		const type: NoticeType = event.approval === true ? "permission_prompt" : "elicitation_dialog";
		fire(
			{ type, title: "Octocode: waiting for you", message: promptTitle(event) ?? "A question needs your answer" },
			true,
		);
	});
	registerPresentWarming(api, {
		focused: () => (focus === "unknown" ? undefined : focus === "focused"),
		lastInputAt: () => lastInputAt,
	});
}

/** The text of the session's first user message, for a resumed session that has no name. */
function firstPromptOf(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager?.getEntries() ?? []) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = contentText(entry.message.content).trim();
		if (text) return text;
	}
	return undefined;
}
