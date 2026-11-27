import { getAgentDir } from "../../../config.ts";
import { renderPrompt } from "../../prompt-template.ts";
import type { SettingsManager } from "../../settings-manager.ts";
import { discoveryInput } from "../service.ts";
import type { ConfigKind } from "../types.ts";
import { harnessStatuses } from "./index.ts";
import type { HarnessStatus } from "./types.ts";

/** The harnesses of a session as its settings switch them (cached by `harnessStatuses` per discovery pass and toggles). */
export function sessionHarnesses(options: {
	cwd: string;
	settings: Pick<SettingsManager, "isProjectTrusted" | "getSettings">;
	agentDir?: string;
}): HarnessStatus[] {
	const toggles = options.settings.getSettings().toggles;
	return harnessStatuses(
		discoveryInput({
			cwd: options.cwd,
			agentDir: options.agentDir ?? getAgentDir(),
			projectTrusted: options.settings.isProjectTrusted(),
			...(toggles ? { toggles } : {}),
		}),
	);
}

/** Kinds worth naming for a harness: what it holds, or what switching it on would add. `[kind, one, many]`. */
const NOUNS: ReadonlyArray<readonly [ConfigKind, string, string]> = [
	["skill", "skill", "skills"],
	["hook", "hook", "hooks"],
	["mcp", "MCP server", "MCP servers"],
	["plugin", "plugin", "plugins"],
	["memory", "memory file", "memory files"],
];

/** `1 skill, 2 MCP servers`: what a harness's folders hold, loaded or not. */
export function foundSummary(status: HarnessStatus): string {
	return NOUNS.flatMap(([kind, one, many]) => {
		const count = status.found[kind] ?? 0;
		if (count === 0) return [];
		return [`${count} ${count === 1 ? one : many}`];
	}).join(", ");
}

/**
 * The main session's one line on the harnesses that supply something now: on, with items in their folders
 * (`native/prompts/system/harnesses.md`, one `system/harness.md` part each), so it knows where its skills, hooks and
 * servers come from and that the user switches them. A harness that is off, or on with nothing found (a root
 * `.mcp.json` that does not exist), gives the model nothing to act on and is left out; `/harness` lists every one. No
 * line when none qualifies.
 */
export function formatHarnessesForPrompt(statuses: readonly HarnessStatus[]): string {
	const supplying = statuses.filter((status) => status.on && Object.values(status.found).some(Boolean));
	if (supplying.length === 0) return "";
	const parts = supplying.map((status) =>
		renderPrompt("system/harness.md", { label: status.label, projectOnly: status.projectOnly === true }),
	);
	return renderPrompt("system/harnesses.md", { harnesses: parts.join(" \u00b7 ") });
}
