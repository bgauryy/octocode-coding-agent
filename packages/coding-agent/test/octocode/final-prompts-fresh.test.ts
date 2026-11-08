import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { captureAll } from "./agent-context/capture.ts";
import { finalFiles, REGENERATE_COMMAND } from "./agent-context/final-prompt.ts";

const FINAL = fileURLToPath(new URL("../../src/octocode/instructions/final", import.meta.url));

/** The committed `instructions/final/` documents are the generator's output for the current prompt sources. */
it("the committed final prompts match what the generator writes now", async () => {
	const expected = finalFiles(await captureAll());
	const committed = fs.existsSync(FINAL) ? fs.readdirSync(FINAL).sort() : [];
	const stale = [...expected.keys()].filter((name) => {
		const file = path.join(FINAL, name);
		return !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== expected.get(name);
	});
	const extra = committed.filter((name) => !expected.has(name));
	expect(
		{ stale, extra },
		`instructions/final/ is out of date; run \`${REGENERATE_COMMAND}\` and commit the result`,
	).toEqual({ stale: [], extra: [] });
	for (const text of expected.values()) {
		expect(text).not.toMatch(/\/Users\/|\/home\/|\/workspace\/|\b20\d\d-\d\d-\d\d\b/);
	}
}, 180_000);
