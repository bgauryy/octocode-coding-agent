import type { ExtensionAPI, ExtensionCommandContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { cancelledText, notify, say, type Subcommands, wordCompletions } from "../shared/commands.ts";
import {
	blockerText,
	databaseBytes,
	executePurge,
	planPurge,
	type PurgeScope,
	previewLines,
	resultLines,
} from "./purge.ts";
import type { SessionIndex } from "./store.ts";

const SCOPES: readonly PurgeScope[] = ["workspace", "all"];

interface PurgeCommandOptions {
	index: () => SessionIndex;
	current: () => string | undefined;
}

/**
 * `/purge workspace|all`: removes this workspace's (or every workspace's and the global) Octocode data after a preview
 * and a typed confirmation. Without a terminal UI it refuses: nothing can be confirmed.
 */
export function registerPurgeCommand(_api: ExtensionAPI, commands: Subcommands, options: PurgeCommandOptions): void {
	commands.add("purge", {
		description: "Delete this workspace's or all Octocode data",
		argumentHint: "workspace|all",
		complete: (prefix) => wordCompletions([...SCOPES], prefix),
		handler: async (args, ctx) => purgeHandler(args.trim(), ctx, options),
	});
}

async function purgeHandler(args: string, ctx: ExtensionCommandContext, options: PurgeCommandOptions): Promise<void> {
	const scope = SCOPES.find((name) => name === args);
	if (!scope)
		return say(
			ctx,
			"Usage: /purge workspace|all. It shows what would be deleted, then asks you to type the scope word.",
			"warning",
		);
	if (!ctx.hasUI)
		return say(
			ctx,
			`Refusing to purge without a terminal to confirm in. Run /purge ${scope} in an interactive session.`,
			"warning",
		);
	let index: SessionIndex;
	try {
		index = options.index();
	} catch (error) {
		return say(ctx, `Octocode could not open its database: ${errorMessage(error)}`, "warning");
	}
	const current = options.current();
	try {
		const plan = await planPurge(index, scope, { cwd: ctx.cwd, ...(current ? { current } : {}) });
		const blocked = blockerText(plan);
		if (blocked) return say(ctx, blocked, "warning");
		say(ctx, [`/purge ${scope} would delete:`, ...previewLines(plan, databaseBytes(index))].join("\n"));
		const typed = await ctx.ui.input(`Purge ${scope}: type "${scope}" to delete the data listed above`, scope);
		if (typed?.trim() !== scope) return notify(ctx.ui, cancelledText("deleted"), "info");
		const outcome = await executePurge(index, scope, { cwd: ctx.cwd, ...(current ? { current } : {}) });
		if ("refused" in outcome) return say(ctx, outcome.refused, "warning");
		say(ctx, resultLines(outcome.result).join("\n"), outcome.result.failed.length > 0 ? "warning" : "info");
	} catch (error) {
		say(ctx, `Purge failed: ${errorMessage(error)}`, "error");
	}
}
