import type { FeatureContext } from "../../core/features/index.ts";
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

/**
 * `/web`: the user-level daemon's page when `daemon` is given (every session), else this session's own server. When the
 * daemon cannot start or this session cannot attach, the session's own server opens instead, after a warning that says
 * why, so `/web` never fails silently.
 */
export function webCommand(
	/** This session's own server, the fallback: opens the page and resolves to its address. */
	open: (ctx: FeatureContext, view: "board" | "activity", item?: string) => Promise<string>,
	/** The user-level daemon: opens its page on this session; throws when it cannot. */
	daemon?: (ctx: FeatureContext, view: "board" | "activity", item?: string) => Promise<void>,
): Subcommand {
	return {
		description: "Open the web workspace",
		argumentHint: "[backlogs|item <id>]",
		complete: (prefix) => wordCompletions(["backlogs", "item"], prefix),
		async handler(args, ctx) {
			const parsed = parseWebArgs(args);
			if (!parsed) {
				say(ctx, USAGE, "warning");
				return;
			}
			const { view, item } = parsed;
			const itemArg = item ? [item] : [];
			if (daemon) {
				try {
					await daemon(ctx, view, ...itemArg);
					say(
						ctx,
						"Opened the web workspace. It keeps running after this session closes and stops by itself after 10 minutes with no browser tab and no attached session (/processes lists it).",
					);
					return;
				} catch (error) {
					say(
						ctx,
						`The web daemon could not start (${errorMessage(error)}), so this session serves the page itself.`,
						"warning",
					);
				}
			}
			try {
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
