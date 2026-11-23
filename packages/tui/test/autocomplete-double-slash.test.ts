import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

const signal = new AbortController().signal;
const provider = () =>
	new CombinedAutocompleteProvider([{ name: "status", description: "Show status" }], process.cwd());

describe("a line starting with //", () => {
	it("is text, not a command: no command menu", async () => {
		// `//status` reaches the app as a prompt, so the menu must not offer to turn it into one.
		for (const line of ["//status", "//", "  //sta"]) {
			const result = await provider().getSuggestions([line], 0, line.length, { signal });
			assert.ok(!result?.items.some((item) => item.kind === "command"), `${line}: ${JSON.stringify(result)}`);
		}
	});

	it("still offers the command menu for one slash", async () => {
		const result = await provider().getSuggestions(["/sta"], 0, 4, { signal });
		assert.deepEqual(
			result?.items.map((item) => item.value),
			["status"],
		);
	});

	it("never replaces a line with a bare command name", () => {
		// A command row applied to any prefix goes in as `/name `: a bare name would be sent to the model.
		const applied = provider().applyCompletion(
			["//status"],
			0,
			8,
			{ value: "status", label: "status", kind: "command" },
			"//status",
		);
		assert.deepEqual(applied.lines, ["/status "]);
		assert.equal(applied.cursorCol, 8);
	});
});
