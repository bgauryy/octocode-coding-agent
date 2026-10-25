import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { webLauncher } from "../shared/web.ts";
import { STATUS } from "../shared/status.ts";
import { backlogCommand } from "./command.ts";
import { type BacklogOptions, type OpenBacklogWeb, openBacklog } from "./context.ts";
import { countsText } from "./format.ts";
import { registerBacklogTool } from "./tool.ts";
import { sharedWorkspaceWeb } from "./shared-web.ts";

interface RegisterBacklogOptions extends BacklogOptions {
	openWeb?: OpenBacklogWeb;
	commands: Subcommands;
	/** Opens the HTML page (`/backlog html`); the system's default application unless replaced. */
	open?: (file: string) => Promise<void>;
}

/**
 * The repository backlog: the `backlog` tool, `/backlog` (registered centrally after
 * `commands` is registered) and footer counts with a persistent `/octocode` hint for backlogs and activity.
 */
export function registerBacklog(
	pi: ExtensionAPI,
	options: RegisterBacklogOptions,
): (ctx: ExtensionCommandContext, view: "board" | "activity") => Promise<void> {
	const { commands, open, ...backlogOptions } = options;

	let currentContext: ExtensionContext | undefined;
	const refresh = (ctx: ExtensionContext) => {
		currentContext = ctx;
		if (!ctx.hasUI || options.isSubagent) return;
		try {
			const backlog = openBacklog(ctx, backlogOptions);
			const text = countsText(backlog.store.counts());
			ctx.ui.setStatus(STATUS.backlog, text || undefined);
		} catch {
			// An unreadable agent database (a foreign file) hides the counts; the tool and command report why.
			ctx.ui.setStatus(STATUS.backlog, undefined);
		}
	};

	const launch = webLauncher(pi, open);
	const openWeb = options.openWeb ? sharedWorkspaceWeb(options.openWeb, backlogOptions.env) : undefined;
	const openView = async (ctx: ExtensionCommandContext, view: "board" | "activity") => {
		const backlog = openBacklog(ctx, backlogOptions);
		await launch(
			backlog.store.repo + ":" + backlog.session,
			async () => {
				if (!openWeb)
					throw new Error("The workspace web app is unavailable in this host. Use /backlog tui or /backlog html.");
				return openWeb(ctx, backlog, () => refresh(ctx));
			},
			view,
		);
	};
	registerBacklogTool(pi, { ...backlogOptions, changed: refresh });
	if (!options.isSubagent)
		commands.add(
			"backlog",
			backlogCommand(pi, {
				...backlogOptions,
				...(open ? { open } : {}),
				changed: refresh,
				items: () => (currentContext ? openBacklog(currentContext, backlogOptions).store.list().items : []),
				openView: (ctx) => openView(ctx, "board"),
			}),
		);
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	// Another session or agent may have changed the board: repaint at the end of every run.
	pi.on("agent_end", (_event, ctx) => refresh(ctx));
	return openView;
}
