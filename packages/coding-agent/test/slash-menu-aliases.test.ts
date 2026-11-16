import { CombinedAutocompleteProvider } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { menuCommands } from "../src/modes/interactive/interactive-mode/command-menu.ts";
import { BUILTIN_SLASH_COMMANDS, COMMAND_ALIASES } from "../src/core/slash-commands.ts";

const suggest = async (text: string) => {
	const commands = menuCommands(BUILTIN_SLASH_COMMANDS.map(({ name, description }) => ({ name, description })));
	const provider = new CombinedAutocompleteProvider(commands, process.cwd());
	const result = await provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
	return result?.items ?? [];
};

describe("slash menu aliases", () => {
	it("suggests the target when typing an alias, naming the alias in the row", async () => {
		const items = await suggest("/exit");
		const quit = items.find((item) => item.value === "quit");
		expect(quit).toBeDefined();
		expect(quit?.description).toContain("also /exit");
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
