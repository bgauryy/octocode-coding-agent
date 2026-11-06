import type { ExtensionContext } from "../../core/features/index.ts";
import { say, type Subcommand, wordCompletions } from "../shared/commands.ts";
import { ITEM_REF } from "../shared/item-ref.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

const USAGE = "Usage: /web [backlogs | item <id>]";

/** `/web` arguments: the view to open and, for `item B12`, the item. Undefined when the arguments are not valid. */
export function parseWebArgs(args: string): { view: "board" | "activity"; item?: string } | undefined {
	const [word, id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
	if (word === undefined) return { view: "activity" };
	if (word === "backlogs" && id === undefined) return { view: "board" };
	if (word !== "item" || extra.length || id === undefined) return undefined;
	const item = id.toUpperCase();
	return ITEM_REF.test(item) ? { view: "board", item } : undefined;
}

export function webCommand(
	/** Opens the page and resolves to its address. */
	open: (ctx: ExtensionContext, view: "board" | "activity", item?: string) => Promise<string>,
	/** The user-level daemon (`OCTOCODE_WEB_DAEMON=1`): true when it opened the page, false when it is off; a throw falls back to `open`. */
	daemon?: (ctx: ExtensionContext, view: "board" | "activity", item?: string) => Promise<boolean>,
): Subcommand {
	return {
		description: "Open the web workspace",
		complete: (prefix) => wordCompletions(["backlogs", "item"], prefix),
		async handler(args, ctx) {
			const parsed = parseWebArgs(args);
			if (!parsed) {
				say(ctx, USAGE, "warning");
				return;
			}
			const { view, item } = parsed;
			const itemArg = item ? [item] : [];
			try {
				if (daemon) {
					try {
						if (await daemon(ctx, view, ...itemArg)) {
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
				const url = await open(ctx, view, ...itemArg);
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
