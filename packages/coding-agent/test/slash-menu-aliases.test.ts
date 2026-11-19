import { CombinedAutocompleteProvider } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { menuCommands } from "../src/modes/interactive/interactive-mode/command-menu.ts";
import { BUILTIN_SLASH_COMMANDS, COMMAND_ALIASES } from "../src/core/slash-commands.ts";

// Skills whose names fuzzy-match the aliases and hidden names below (`todos` → octocode-roast), as installed skills do.
const SKILLS = ["octocode-roast", "octocode-local-research", "resume-external-harness", "octocode-clean-agentic-code"];

const BUILTIN_NAMES = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
/** Alias targets that are feature commands (/backlog, /rewind), registered at runtime beside the builtins. */
const FEATURE_TARGETS = [...new Set(COMMAND_ALIASES.values())].filter((name) => !BUILTIN_NAMES.has(name));

const suggest = async (text: string) => {
	const commands = menuCommands([
		...BUILTIN_SLASH_COMMANDS.map(({ name, description }) => ({ name, description })),
		...FEATURE_TARGETS.map((name) => ({ name })),
		...SKILLS.map((name) => ({ name, skill: true })),
	]);
	const provider = new CombinedAutocompleteProvider(commands, process.cwd());
	const result = await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
	return result?.items ?? [];
};

describe("slash menu aliases", () => {
	it("resolves `settings` to `configuration`", () => {
		expect(COMMAND_ALIASES.get("settings")).toBe("configuration");
	});

	it("suggests the target when typing an alias, naming the alias in the row", async () => {
		const items = await suggest("/exit");
		const quit = items.find((item) => item.value === "quit");
		expect(quit).toBeDefined();
		expect(quit?.description).toContain("also /exit");
	});

	// Enter runs the first suggestion (no row equals `/name` with its slash), so a name typed in full must come first.
	it("lists the typed command first: an alias's target, a hidden builtin's target, a command's own name", async () => {
		const first = async (text: string) => (await suggest(text))[0]?.value;
		for (const [alias, target] of COMMAND_ALIASES) expect(await first(`/${alias}`), `/${alias}`).toBe(target);
		expect(await first("/clear")).toBe("new");
		expect(await first("/reset")).toBe("new");
		for (const { name, menuAliasOf } of BUILTIN_SLASH_COMMANDS)
			if (!menuAliasOf) expect(await first(`/${name}`), `/${name}`).toBe(name);
	});

	it("names the hidden builtins on their target's row, never as rows of their own", async () => {
		const items = await suggest("/new");
		expect(items.find((item) => item.value === "new")?.description).toContain("also /clear /reset");
		const all = menuCommands(BUILTIN_SLASH_COMMANDS.map(({ name, description }) => ({ name, description })));
		expect(all.map((c) => c.name)).not.toContain("clear");
		expect(all.map((c) => c.name)).not.toContain("reset");
	});

	it("never lists an alias as its own row", async () => {
		for (const alias of COMMAND_ALIASES.keys()) {
			const items = await suggest(`/${alias}`);
			expect(items.map((item) => item.value)).not.toContain(alias);
		}
		const all = menuCommands(BUILTIN_SLASH_COMMANDS.map(({ name, description }) => ({ name, description })));
		for (const alias of COMMAND_ALIASES.keys()) expect(all.map((c) => c.name)).not.toContain(alias);
	});
});
