import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { STATUS } from "../shared/status.ts";
import { backlogCommand } from "./command.ts";
import { type BacklogOptions, openBacklog } from "./context.ts";
import { countsText } from "./format.ts";
import { registerBacklogTool } from "./tool.ts";

interface RegisterBacklogOptions extends BacklogOptions {
	commands: Subcommands;
	/** Opens the HTML page (`/backlog html`); the system's default application unless replaced. */
	open?: (file: string) => Promise<void>;
}

/**
 * The repository backlog: the `backlog` tool, `/octocode backlog` (alias it with `commands.alias(pi, 'backlog')` after
 * `commands` is registered) and footer counts in words with the `/backlog` hint that opens the board.
 */
export function registerBacklog(pi: ExtensionAPI, options: RegisterBacklogOptions): void {
	const { commands, open, ...backlogOptions } = options;

	const refresh = (ctx: ExtensionContext) => {
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

	registerBacklogTool(pi, { ...backlogOptions, changed: refresh });
	if (!options.isSubagent)
		commands.add("backlog", backlogCommand(pi, { ...backlogOptions, ...(open ? { open } : {}), changed: refresh }));
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	// Another session or agent may have changed the board: repaint at the end of every run.
	pi.on("agent_end", (_event, ctx) => refresh(ctx));
}
