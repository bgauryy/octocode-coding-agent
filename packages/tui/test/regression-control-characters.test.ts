import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Input } from "../src/components/input.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image/capabilities.ts";
import { imageFallback, renderImage } from "../src/terminal-image.ts";

const OSC_52 = "\x1b]52;c;aGk=\x07";

function fdPath(): string | null {
	const result = spawnSync("sh", ["-c", "command -v fd || command -v fdfind"], { encoding: "utf-8" });
	return result.status === 0 ? result.stdout.trim() || null : null;
}

describe("file autocomplete with control characters in names", () => {
	it("never offers a name that would write an escape sequence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tui-ctrl-"));
		try {
			writeFileSync(join(dir, `evil${OSC_52}.txt`), "");
			writeFileSync(join(dir, "evident.txt"), "");
			const fd = fdPath();
			const provider = new CombinedAutocompleteProvider([], dir, fd);
			const signal = new AbortController().signal;
			const queries: Array<[string, number]> = [["./", 2]];
			if (fd) queries.push(["@ev", 3]);
			for (const [line, col] of queries) {
				const suggestions = await provider.getSuggestions([line], 0, col, { signal });
				const text = JSON.stringify(suggestions?.items ?? []);
				assert.ok(text.includes("evident.txt"), `${line}: ordinary names are still offered`);
				assert.ok(!/\\u001b|\\u0007/.test(text), `${line}: ${text}`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Input paste with control characters", () => {
	it("drops them like typed input does", () => {
		const input = new Input();
		input.handleInput(`\x1b[200~a${OSC_52}b\x9b2J\x1b[201~`);
		assert.strictEqual(input.getValue(), "a]52;c;aGk=b2J");
	});
});

describe("image escape payloads", () => {
	afterEach(() => resetCapabilitiesCache());

	for (const images of ["kitty", "iterm2"] as const) {
		it(`${images}: refuses image data that is not base64`, () => {
			setCapabilities({ images, trueColor: true, hyperlinks: false });
			const dimensions = { widthPx: 10, heightPx: 10 };
			assert.ok(renderImage("iVBORw0KGgo=", dimensions), "valid base64 still renders");
			assert.strictEqual(renderImage(`AAAA\x1b\\${OSC_52}`, dimensions), null);
		});
	}

	it("strips control characters from the fallback text", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const text = imageFallback(`image/png${OSC_52}`, undefined, `shot${OSC_52}.png`);
		assert.ok(!/[\x07\x1b]/.test(text), JSON.stringify(text));
	});
});
