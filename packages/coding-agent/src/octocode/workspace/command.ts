import type { ExtensionCommandContext } from "../../core/extensions/index.ts";
import { say, type Subcommand, wordCompletions } from "../shared/commands.ts";
import { errorMessage } from "../../utils/guards.ts";

export function webCommand(
	open: (ctx: ExtensionCommandContext, view: "board" | "activity") => Promise<void>,
): Subcommand {
	return {
		aliases: ["web"],
		description: "Open the web workspace — /octocode [backlogs]",
		complete: (prefix) => wordCompletions(["backlogs"], prefix),
		async handler(args, ctx) {
			if (args.trim() && args.trim() !== "backlogs") {
				say(ctx, "Usage: /octocode [backlogs]", "warning");
				return;
			}
			try {
				await open(ctx, args.trim() === "backlogs" ? "board" : "activity");
				say(ctx, "Opened the web workspace. Keep this session open for live updates.");
			} catch (error) {
				say(ctx, "Could not open the web workspace: " + errorMessage(error), "error");
			}
		},
	};
}
