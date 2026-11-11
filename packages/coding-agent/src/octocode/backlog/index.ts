import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { webLauncher } from "../browser/launcher.ts";
import { STATUS } from "../shared/status.ts";
import { backlogCommand } from "./command.ts";
import { registerBacklogDigest } from "./digest.ts";
import { type BacklogOptions, type OpenBacklogWeb, openBacklog } from "./context.ts";
import { countsText, openTaskCount } from "./format.ts";
import { refreshItemTitles } from "./title-lookup.ts";
import { registerBacklogPlanTool } from "./plan-tool.ts";
import { registerBacklogTool } from "./tool.ts";
import { sharedWorkspaceWeb } from "./shared-web.ts";

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
	const refresh = (ctx: ExtensionContext) => {
		currentContext = ctx;
		if (!ctx.hasUI || options.isSubagent) return;
		try {
			const backlog = openBacklog(ctx, backlogOptions);
			refreshItemTitles(backlog.store);
			const text = countsText(backlog.store.counts(), openTaskCount(backlog.store, backlog.session));
			ctx.ui.setStatus(STATUS.backlog, text || undefined);
		} catch {
			// An unreadable agent database (a foreign file) hides the counts; the tool and command report why.
			ctx.ui.setStatus(STATUS.backlog, undefined);
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
	if (!options.isSubagent) registerBacklogDigest(api, backlogOptions);
	api.on("session_start", (_event, ctx) => refresh(ctx));
	// Another session or agent may have changed the board: repaint at the end of every run.
	api.on("agent_end", (_event, ctx) => refresh(ctx));
	return { open: openView, refresh };
}
