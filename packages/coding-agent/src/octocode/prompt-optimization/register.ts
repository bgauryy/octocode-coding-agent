import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/features/index.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { notify, say, type Subcommands, wordCompletions } from "../shared/commands.ts";
import { reviewPrompt } from "./review.ts";

const USAGE = "Usage: /optimize [on|off]";

const describe = (enabled: boolean): string =>
	`Prompt optimization is ${enabled ? "on" : "off"}.${enabled ? " Each prompt you submit is rewritten by a helper model, and you choose what is sent." : ""}`;

/**
 * `/optimize [on|off]` and the input hook it controls. While on, each plain prompt submitted in the terminal goes to
 * `reviewPrompt` before the session sees it; slash commands, `!` lines and empty input pass untouched. The setting
 * (`optimizePrompts`) is saved to the global settings; the running session keeps its own copy, which the command updates,
 * because settings written from here reach the session's settings only on the next load.
 */
export function registerPromptOptimization(commands: Subcommands, api: ExtensionAPI): void {
	let enabled: boolean | undefined;
	const isEnabled = (): boolean => (enabled ??= api.getSettings().optimizePrompts === true);

	function save(on: boolean, ctx: ExtensionCommandContext): void {
		try {
			SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).setOptimizePrompts(on);
		} catch (error) {
			enabled = on;
			say(
				ctx,
				`${describe(on)} It could not be saved (${errorMessage(error)}), so it applies to this session only.`,
				"warning",
			);
			return;
		}
		enabled = on;
		say(ctx, describe(on));
	}

	commands.add("optimize", {
		description: "Rewrite each prompt with a helper model",
		argumentHint: "[on|off]",
		dialog: "interaction",
		complete: (prefix) => wordCompletions(["on", "off"], prefix),
		handler: async (args, ctx) => {
			const word = args.trim().toLowerCase();
			if (word === "on" || word === "off") return save(word === "on", ctx);
			if (word) return say(ctx, USAGE, "warning");
			const current = isEnabled();
			if (!ctx.hasUI) return say(ctx, `${describe(current)} ${USAGE}`);
			const toggle = current ? "Turn off" : "Turn on";
			if ((await ctx.ui.select(describe(current), [toggle, "Keep it"])) === toggle) save(!current, ctx);
		},
	});

	api.on("input", async (event, ctx) => {
		const text = event.text.trim();
		if (event.source !== "interactive" || !ctx.hasUI || !isEnabled()) return { action: "continue" };
		if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
		const chosen = await reviewPrompt(ctx, event.text);
		if (chosen === undefined) {
			ctx.ui.setEditorText(event.text);
			notify(ctx.ui, "The prompt was not sent; it is back in the editor.", "warning");
			return { action: "handled" };
		}
		return chosen === event.text ? { action: "continue" } : { action: "transform", text: chosen };
	});
}
