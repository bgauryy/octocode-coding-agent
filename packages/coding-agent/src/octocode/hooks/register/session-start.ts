import { renderInstruction } from "../../../core/prompt-template.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../core/features/index.ts";
import { notify } from "../../shared/commands.ts";
import { STATUS } from "../../shared/status.ts";
import { effectivePlugins } from "../../../core/extensibility/toggles.ts";
import { loadHooks } from "../config.ts";
import { capContext } from "../runner.ts";
import { CONTEXT_TYPE, type Dispatch, type HookSession, type ReportFailure, START_HOOKS_WAIT_MS } from "./types.ts";

/** Octocode's session start reasons in Claude Code's SessionStart matcher vocabulary. */
const START_SOURCE: Record<string, string> = {
	startup: "startup",
	reload: "startup",
	new: "clear",
	resume: "resume",
	fork: "fork",
};

/**
 * SessionStart (also after a compaction, source `compact`): loads the hook config on each session start, runs the
 * SessionStart hooks, and hands their context to the next prompt.
 */
export function registerSessionStartHooks(
	api: ExtensionAPI,
	session: HookSession,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
	home: string | undefined,
	child = false,
): void {
	let pending: string[] = [];
	/** SessionStart hook commands still running: the next prompt waits for their context, session start does not. */
	let starting: Promise<void> | undefined;
	/** Ends the current session's SessionStart hooks (on shutdown or the next session start), so none outlive it. */
	let startAbort = new AbortController();

	/**
	 * Starts the SessionStart hooks matching `source`. Hook commands can be slow (they spawn processes): they run
	 * without holding up the event. A result that arrives after the session was replaced belongs to the old one and is
	 * dropped. A session start ends the previous session's runs; a compaction's run joins any still going.
	 */
	const startHooks = (ctx: ExtensionContext, source: string, fresh: boolean): void => {
		if (fresh) {
			startAbort.abort();
			startAbort = new AbortController();
		}
		const abort = startAbort;
		const previous = fresh ? undefined : starting;
		const hooks = Promise.all(
			(["octocode", "claude", "codex"] as const)
				.filter((protocol) => !child || protocol === "octocode")
				.map((protocol) => {
					const profileSource = protocol === "octocode" && source === "fork" ? "resume" : source;
					return dispatch(
						ctx,
						"SessionStart",
						[profileSource],
						() => ({ source: profileSource }),
						abort.signal,
						protocol,
					);
				}),
		)
			.then((verdicts) => {
				if (!abort.signal.aborted) for (const verdict of verdicts) if (verdict.context) pending.push(verdict.context);
			})
			.catch((error: unknown) => {
				if (!abort.signal.aborted) reportFailure(ctx, "SessionStart", error);
			});
		const run: Promise<void> = (previous ? Promise.all([previous, hooks]) : hooks)
			.then(() => undefined)
			.finally(() => {
				if (starting === run) starting = undefined;
			});
		starting = run;
	};

	api.on("session_start", async (event, ctx) => {
		const settings = api.getSettings();
		const loaded = loadHooks(ctx.cwd, ctx.isProjectTrusted(), home, {
			plugins: effectivePlugins(settings, ctx.cwd),
			toggles: settings.toggles,
		});
		session.config = loaded.config;
		session.errors = loaded.errors;
		session.root = undefined;
		pending = [];
		if (loaded.errors.length > 0 && ctx.hasUI)
			notify(ctx.ui, `Hook configuration diagnostics: ${loaded.errors.join("; ")}`, "warning");
		startHooks(ctx, START_SOURCE[event.reason] ?? "startup", true);
	});
	// Claude Code runs SessionStart again (source `compact`) after a compaction: its context comes with the next prompt.
	api.on("session_compact", async (_event, ctx) => startHooks(ctx, "compact", false));
	api.on("session_shutdown", async () => startAbort.abort());

	// SessionStart context reaches the model once, with the next prompt, as data rather than instructions.
	api.on("before_agent_start", async (_event, ctx) => {
		// The first prompt waits a bounded time for their context; a slower hook's context comes with the next prompt.
		if (starting) {
			// Shown only while the prompt actually waits: `starting` clears itself once the hooks finish.
			if (ctx.hasUI) ctx.ui.setStatus(STATUS.hooks, "Waiting for SessionStart hooks…");
			try {
				await Promise.race([starting, new Promise((resolve) => setTimeout(resolve, START_HOOKS_WAIT_MS).unref())]);
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS.hooks, undefined);
			}
		}
		if (pending.length === 0) return undefined;
		const content = capContext(
			renderInstruction("notices/hooks/context.md", { source: "SessionStart", text: pending.join("\n\n") }),
		);
		pending = [];
		return { message: { customType: CONTEXT_TYPE, content, display: false } };
	});
}
