import type { ExtensionCommandContext } from "../../core/extensions/index.ts";
import { say, type Subcommand, wordCompletions } from "../shared/commands.ts";
import { errorMessage } from "../../utils/guards.ts";

export function webCommand(
	/** Opens the page and resolves to its address. */
	open: (ctx: ExtensionCommandContext, view: "board" | "activity") => Promise<string>,
	/** The user-level daemon (`OCTOCODE_WEB_DAEMON=1`): true when it opened the page, false when it is off; a throw falls back to `open`. */
	daemon?: (ctx: ExtensionCommandContext, view: "board" | "activity") => Promise<boolean>,
): Subcommand {
	return {
		description: "Open the web workspace — /octocode [backlogs]",
		complete: (prefix) => wordCompletions(["backlogs"], prefix),
		async handler(args, ctx) {
			if (args.trim() && args.trim() !== "backlogs") {
				say(ctx, "Usage: /octocode [backlogs]", "warning");
				return;
			}
			const view = args.trim() === "backlogs" ? "board" : "activity";
			try {
				if (daemon) {
					try {
						if (await daemon(ctx, view)) {
							say(ctx, "Opened the web workspace. It keeps running after this session closes.");
							return;
						}
					} catch (error) {
						say(
							ctx,
							"The web daemon is unavailable (" + errorMessage(error) + "); using this session's own server.",
							"warning",
						);
					}
				}
				const url = await open(ctx, view);
				say(
					ctx,
					`Opened the web workspace at ${url}\nKeep this session open for live updates; it stops when the session ends.`,
				);
			} catch (error) {
				say(ctx, "Could not open the web workspace: " + errorMessage(error), "error");
			}
		},
	};
}
