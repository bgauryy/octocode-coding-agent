import { contentText } from "@octocodeai/octocode-ai";
import {
	NextCommandSuggester,
	replyCommands,
	ShellCompletionService,
	type ShellCompletionOptions,
} from "../../../../terminal/src/index.ts";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { getShellEnv } from "../../utils/shell.ts";
import { GhostController } from "./ghost.ts";
import { ShellHistoryStore } from "./history.ts";
import { askSmallModel } from "./model.ts";
import { ShellAwareProvider } from "./provider.ts";

/** Recent commands the model sees. */
const RECENT_FOR_MODEL = 10;

const DEFAULTS = SETTINGS_DEFAULTS.terminal;

/** Whether the global settings let a model be asked: a project file can turn it off, never on. */
function modelAllowedGlobally(agentDir: string): boolean {
	try {
		const global = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getSettings();
		return global.terminal?.suggestions?.model ?? DEFAULTS.suggestions.model;
	} catch {
		return false;
	}
}

/** The command and exit code of the newest `!` result in the session, if any. */
function lastBashResult(ctx: ExtensionContext): { command: string; exitCode: number } | undefined {
	const entries = ctx.sessionManager.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role: string; command?: string; exitCode?: number };
		if (message.role !== "bashExecution") continue;
		return typeof message.exitCode === "number" && message.command
			? { command: message.command, exitCode: message.exitCode }
			: undefined;
	}
	return undefined;
}

/** The shell commands of the newest assistant reply in the session. */
function lastReply(ctx: ExtensionContext): string[] {
	const entries = ctx.sessionManager.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message.role === "assistant")
			return replyCommands(contentText(entry.message.content));
	}
	return [];
}

/**
 * `!` shell mode in the terminal: Tab completes from the user's own shell (`packages/terminal`), and ghost text
 * suggests the rest of the command from the agent's last reply, the `!` history, or the small model.
 */
export function registerTerminal(api: ExtensionAPI, options: { agentDir?: string } = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const history = new ShellHistoryStore();
	let ctx: ExtensionContext | undefined;
	let service: ShellCompletionService | undefined;
	let ghost: GhostController | undefined;
	let stopListening: (() => void) | undefined;
	let providerAdded = false;
	let reply: string[] = [];
	let lastRun: { cwd: string; command: string } | undefined;
	let modelAllowed: boolean | undefined;
	const suggester = new NextCommandSuggester((request, signal) =>
		ctx ? askSmallModel(api, ctx, request, signal) : Promise.resolve(undefined),
	);
	const terminal = () => api.getSettings().terminal;
	const completion = (): ShellCompletionOptions => ({
		shell: terminal()?.completion?.shell ?? DEFAULTS.completion.shell,
		loadRc: terminal()?.completion?.loadRc ?? DEFAULTS.completion.loadRc,
		carapace: terminal()?.completion?.carapace ?? DEFAULTS.completion.carapace,
	});
	/** Stores the exit code of the command recorded last, once the session holds its result. */
	const settleLastRun = () => {
		if (!ctx || !lastRun) return;
		const result = lastBashResult(ctx);
		if (result?.command === lastRun.command) history.setExit(lastRun.cwd, lastRun.command, result.exitCode);
		lastRun = undefined;
	};

	/** Sets up completion and ghost text for a started terminal session; a UI without the editor hooks gets neither. */
	const start = (started: ExtensionContext) => {
		ctx = started;
		const ui = started.ui as Partial<ExtensionContext["ui"]>;
		const settings = {
			...completion(),
			cwd: started.cwd,
			env: getShellEnv(),
			trusted: () => ctx?.isProjectTrusted() ?? false,
		};
		if (service) service.update(settings);
		else service = new ShellCompletionService(settings);
		if (!providerAdded && typeof ui.addAutocompleteProvider === "function") {
			providerAdded = true;
			ui.addAutocompleteProvider((base) => new ShellAwareProvider(base, () => service));
		}
		if (typeof ui.onEditorChange !== "function" || typeof ui.setEditorSuggestion !== "function") return;
		reply = lastReply(started);
		suggester.forget();
		ghost ??= new GhostController({
			setSuggestion: (text) => ctx?.ui.setEditorSuggestion?.(text),
			cwd: () => ctx?.cwd ?? process.cwd(),
			history: () => history.entries(),
			reply: () => reply,
			historyEnabled: () => terminal()?.suggestions?.history ?? DEFAULTS.suggestions.history,
			modelEnabled: () =>
				Boolean(ctx?.model) &&
				terminal()?.suggestions?.model !== false &&
				(modelAllowed ??= modelAllowedGlobally(agentDir)),
			suggester,
			request: (prefix) => ({
				prefix,
				cwd: ctx?.cwd ?? process.cwd(),
				shell: service?.shellName ?? "bash",
				platform: process.platform,
				recent: history
					.entries()
					.filter((entry) => entry.cwd === (ctx?.cwd ?? ""))
					.slice(0, RECENT_FOR_MODEL)
					.reverse()
					.map((entry) => ({ command: entry.command, exitCode: entry.lastExit })),
				reply,
			}),
		});
		stopListening ??= ui.onEditorChange((text) => ghost?.update(text));
	};

	api.on("session_start", (_event, started) => {
		if (started.mode !== "tui" || !started.hasUI) return;
		try {
			start(started);
		} catch {
			// Completion is a convenience: a failure here must never stop the session from starting.
		}
	});

	api.on("user_bash", (event) => {
		settleLastRun();
		const command = event.command.trim();
		if (command && !command.includes("\n")) {
			history.record(event.cwd, command);
			lastRun = { cwd: event.cwd, command };
		}
		suggester.forget();
		ghost?.reset();
		return undefined;
	});

	api.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		reply = replyCommands(contentText(event.message.content));
		suggester.forget();
	});

	api.on("session_shutdown", () => {
		settleLastRun();
		stopListening?.();
		stopListening = undefined;
		ghost?.dispose();
		ghost = undefined;
		service?.dispose();
		service = undefined;
		ctx = undefined;
	});
}
