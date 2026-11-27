import { renderPrompt } from "../../core/prompt-template.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import type { HookConfig } from "./contracts.ts";
import type { HooksView } from "./register/types.ts";

/**
 * The `hooks` section: one line per configured event and tool matcher, so an agent knows what may act on its calls.
 * It names no command, URL or prompt, which can hold secrets. Empty without a hook, which removes the section.
 */
export function hooksPromptSection(config: HookConfig): string {
	const lines = Object.entries(config).flatMap(([event, groups]) =>
		groups
			.filter((group) => group.hooks.length > 0)
			.map((group) => `- ${event}${group.matcher && group.matcher !== "*" ? `: ${group.matcher}` : ""}`),
	);
	return lines.length > 0 ? renderPrompt("sections/hooks.md", { hooks: [...new Set(lines)].join("\n") }) : "";
}

/** Keeps the section in step with the hooks loaded now: a reload, a resume or a pause changes it, and "" removes it. */
export function registerHooksPromptSection(api: FeatureSetup, hooks: Pick<HooksView, "promptSection">): void {
	api.bus.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections.hooks = hooks.promptSection();
		return undefined;
	});
}
