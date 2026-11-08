import { getAgentDir } from "../../../config.ts";
import { renderInstruction } from "../../prompt-template.ts";
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
 * The main session's one line on every harness Octocode reads, on or off, so it knows what exists and that the user
 * decides (`instructions/system/harnesses.md`, one `system/harness.md` part per harness). A harness that is off names
 * what it holds; one that is on needs no count, its items are in the prompt and tools.
 */
export function formatHarnessesForPrompt(statuses: readonly HarnessStatus[]): string {
	if (statuses.length === 0) return "";
	const parts = statuses.map((status) =>
		renderInstruction("system/harness.md", {
			label: status.label,
			on: status.on,
			projectOnly: status.projectOnly === true,
			found: status.on ? "" : foundSummary(status),
		}),
	);
	return renderInstruction("system/harnesses.md", { harnesses: parts.join(" \u00b7 ") });
}
