import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { webLauncher } from "../browser/launcher.ts";
import { STATUS } from "../shared/status.ts";
import { DatabaseFollower } from "../shared/database-follower.ts";
import { backlog as backlogQueries, dbStamp } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { backlogCommand } from "./command.ts";
import { registerBacklogDigest } from "./digest.ts";
import { type BacklogOptions, type OpenBacklogWeb, openBacklog } from "./context.ts";
import { countsText, sessionTaskTally, taskProgressText } from "./format.ts";
import { refreshItemTitles } from "./title-lookup.ts";
import { registerBacklogPlanTool } from "./plan-tool.ts";
import { registerBacklogTool } from "./tool.ts";
import { sharedWorkspaceWeb } from "./shared-web.ts";
import { releaseOwn, restoreOwn } from "./lifetime.ts";
import { registerTaskEvents } from "./task-events.ts";

interface RegisterBacklogOptions extends BacklogOptions {
	openWeb?: OpenBacklogWeb;
	commands: Subcommands;
	/** Opens the HTML page (`/backlog html`); the system's default application unless replaced. */
	open?: (file: string) => Promise<void>;
}

/** What the web commands need of the backlog. */
export interface BacklogWebHooks {
	/** Opens this session's own workspace server (the fallback when the web daemon cannot start); resolves to its address. */
	open: (ctx: ExtensionContext, view: "board" | "activity", item?: string) => Promise<string>;
	/** Repaints the footer counts; the web daemon asks for it after an edit on its page. */
	refresh: (ctx: ExtensionContext) => void;
}

/**
 * The repository backlog: the `backlog` and `backlogPlan` tools, `/backlog` (registered centrally after
 * `commands` is registered; `/backlog web` runs `/web backlogs` when that is registered) and footer counts with a
 * persistent `/web` hint for backlogs and activity.
 */
export function registerBacklog(api: ExtensionAPI, options: RegisterBacklogOptions): BacklogWebHooks {
	const { commands, open, ...backlogOptions } = options;

	let currentContext: ExtensionContext | undefined;
	let lastAudit: number | undefined;
	let stopFollowing: (() => void) | undefined;
	let stopRunFollowing: (() => void) | undefined;
	const stopRun = () => {
		stopRunFollowing?.();
		stopRunFollowing = undefined;
	};
	const database = () => sharedAgentDb(backlogOptions.env ?? process.env);
	const follower = new DatabaseFollower(() => {
		try {
			return dbStamp(database().file);
		} catch {
			return "unreadable";
		}
	});
	const refresh = (ctx: ExtensionContext, changedOnly = false) => {
		currentContext = ctx;
		if (!ctx.hasUI || options.isSubagent) return;
		try {
			const backlog = openBacklog(ctx, backlogOptions);
			const audit = Number(
				backlogQueries.auditRows(database().db, backlog.store.repo, undefined, undefined, 1)[0]?.id ?? 0,
			);
			if (changedOnly && audit === lastAudit) return;
			lastAudit = audit;
			refreshItemTitles(backlog.store);
			const text = countsText(backlog.store.counts());
			ctx.ui.setStatus(STATUS.backlog, text || undefined);
			ctx.ui.setStatus(STATUS.steps, taskProgressText(sessionTaskTally(backlog.store, backlog.session)));
		} catch {
			// An unreadable agent database (a foreign file) hides the counts; the tool and command report why.
			lastAudit = undefined;
			ctx.ui.setStatus(STATUS.backlog, undefined);
			ctx.ui.setStatus(STATUS.steps, undefined);
		}
	};

	const launch = webLauncher(api, open);
	const openWeb = options.openWeb ? sharedWorkspaceWeb(options.openWeb, backlogOptions.env) : undefined;
	const openView = async (ctx: ExtensionContext, view: "board" | "activity", item?: string) => {
		const backlog = openBacklog(ctx, backlogOptions);
		return launch(
			backlog.store.repo + ":" + backlog.session,
			async () => {
				if (!openWeb)
					throw new Error("The workspace web app is unavailable in this host. Use /backlog tui or /backlog html.");
				return openWeb(ctx, backlog, () => refresh(ctx));
			},
			view,
			item,
		);
	};
	registerBacklogTool(api, { ...backlogOptions, changed: refresh });
	registerBacklogPlanTool(api, { ...backlogOptions, changed: refresh });
	if (!options.isSubagent)
		commands.add(
			"backlog",
			backlogCommand(api, {
				...backlogOptions,
				...(open ? { open } : {}),
				changed: refresh,
				items: () => (currentContext ? openBacklog(currentContext, backlogOptions).store.list().items : []),
				openView: (ctx) => openView(ctx, "board"),
				web: () => commands.get("web"),
			}),
		);
	if (!options.isSubagent)
		// Claims follow the session: a resume takes back what its exit returned, before the digest and the counts read the board.
		api.on("session_start", (event, ctx) => {
			if (event.reason !== "startup" && event.reason !== "resume") return;
			try {
				const { store, actor } = openBacklog(ctx, backlogOptions);
				restoreOwn(store, actor);
			} catch {
				// An unreadable database restores nothing; the backlog tool reports the cause when asked.
			}
		});
	// Foreign changes and the task line, for subagents too; registered before the digest, so the digest stays the turn's last result.
	const events = registerTaskEvents(api, backlogOptions);
	if (!options.isSubagent) registerBacklogDigest(api, backlogOptions);
	api.on("session_start", (_event, ctx) => {
		stopFollowing?.();
		stopRun();
		lastAudit = undefined;
		refresh(ctx);
		// The footer repaints while a main session with a UI is open.
		stopFollowing =
			ctx.hasUI && !options.isSubagent
				? follower.subscribe(() => {
						if (currentContext) refresh(currentContext, true);
					})
				: undefined;
	});
	// Every session, subagents included, hears a foreign change to a held item during a run, not only after a tool result.
	api.on("agent_start", (_event, ctx) => {
		stopRun();
		stopRunFollowing = follower.subscribe(() => events.poke(ctx));
	});
	api.on("session_shutdown", (event, ctx) => {
		stopFollowing?.();
		stopFollowing = undefined;
		stopRun();
		currentContext = undefined;
		// A reload continues this session; any other end returns its claims (a subagent holds none).
		if (options.isSubagent || event.reason === "reload") return;
		try {
			const { store, actor } = openBacklog(ctx, backlogOptions);
			releaseOwn(store, actor);
		} catch {
			// An unreadable database must not hold up quitting; the claims then wait for the start-up sweep.
		}
	});
	// Another session or agent may have changed the board: repaint at the end of every run.
	api.on("agent_end", (_event, ctx) => {
		stopRun();
		refresh(ctx);
	});
	return { open: openView, refresh };
}
