import { join } from "node:path";
import { collectAutoPromptEntries, collectAutoThemeEntries } from "../../package-manager/auto-entries.ts";
import { themeName } from "../roots.ts";
import {
	contextItems,
	directoryItems,
	piHookItems,
	namedFileItems,
	productRoots,
	promptName,
	skillItemsIn,
} from "../sources.ts";
import type { ConfigItem, DiscoverInput } from "../types.ts";
import { mcpSource } from "./mcp-items.ts";
import { vendorDefaultOn } from "./switch.ts";
import type { Vendor } from "./types.ts";

/** Pi's project `.pi/` (only with Pi compatibility) and global roots (`~/.pi/agent`, `~/.pi`). */
const roots = (input: DiscoverInput) => productRoots(input, "pi");

const skills = (input: DiscoverInput): ConfigItem[] =>
	roots(input).flatMap((root) => skillItemsIn([join(root.dir, "skills")], root, input));

/** Pi's folders. Its TypeScript hooks never run (they are listed); its models, settings and keybindings load whatever the switch says. */
export const piVendor: Vendor = {
	id: "pi",
	label: "Pi",
	defaultOn: vendorDefaultOn("pi"),
	switchable: true,
	alwaysOn: ["model", "setting", "keybinding"],
	sources: [
		{ kind: "skill", discover: skills },
		{
			kind: "prompt",
			discover: (input) =>
				directoryItems("prompt", "prompts", collectAutoPromptEntries, promptName, roots(input), input),
		},
		{
			kind: "theme",
			discover: (input) => directoryItems("theme", "themes", collectAutoThemeEntries, themeName, roots(input), input),
		},
		// Pi's `hooks/` held TypeScript hooks until Pi 0.35 merged them into extensions; Octocode's hooks are JSON files.
		{ kind: "hook", discover: (input) => piHookItems("hooks", roots(input), input) },
		{ kind: "context", discover: (input) => contextItems(roots(input), input) },
		{
			kind: "systemPrompt",
			discover: (input) => namedFileItems("systemPrompt", "SYSTEM.md", ["project", "global"], roots(input), input),
		},
		{
			kind: "appendSystemPrompt",
			discover: (input) =>
				namedFileItems("appendSystemPrompt", "APPEND_SYSTEM.md", ["project", "global"], roots(input), input),
		},
		{
			kind: "keybinding",
			discover: (input) => namedFileItems("keybinding", "keybindings.json", ["global"], roots(input), input),
		},
		{ kind: "model", discover: (input) => namedFileItems("model", "models.json", ["global"], roots(input), input) },
		{
			kind: "setting",
			discover: (input) => namedFileItems("setting", "settings.json", ["project", "global"], roots(input), input),
		},
		// `.pi/mcp.json` belongs to Pi's project folder, which exists only with Pi compatibility.
		{
			kind: "mcp",
			discover: (input) =>
				mcpSource("pi")
					.discover(input)
					.filter((item) => item.provenance.scope !== "project" || input.piRoots.length > 0),
		},
	],
};
