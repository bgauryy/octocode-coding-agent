import type { CommandContext } from "../../../core/features/index.ts";
import { builtinDescription } from "../../../core/slash-commands.ts";
import { type Subcommands, say } from "../../shared/commands.ts";
import { type MessagesData, messagesPage, messagesText } from "./page.ts";

const USAGE = "Usage: /messages [internal]";

/**
 * `/messages [internal]`: a page of every message of the team with who sent it to whom, where each ran and, on Enter, the
 * whole text and the sender's thinking and output. `internal` starts with internal notices shown. `open` reads the
 * database and transcripts (the composition root supplies it), so the page itself depends on neither.
 */
export function registerMessagesCommand(commands: Subcommands, open: (ctx: CommandContext) => MessagesData): void {
	commands.add("messages", {
		dialog: "interaction",
		description: builtinDescription("messages"),
		argumentHint: "[internal]",
		argumentWords: ["internal"],
		handler: async (args, ctx) => {
			const word = args.trim();
			if (word !== "" && word !== "internal") return say(ctx, USAGE, "warning");
			const data = open(ctx);
			const internal = word === "internal";
			if (!ctx.hasUI) return say(ctx, messagesText(data.feed, internal));
			await messagesPage({ ...data, ui: ctx.ui, internal });
		},
	});
}
