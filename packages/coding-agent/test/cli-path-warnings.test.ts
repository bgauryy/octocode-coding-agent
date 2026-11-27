import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingCliPathWarnings } from "../src/main/cli-path-warnings.ts";

describe("missingCliPathWarnings", () => {
	it("names each local path that is not there and says nothing was loaded from it", () => {
		expect(missingCliPathWarnings("--theme", "theme", ["/no/such"])).toEqual([
			{ type: "warning", message: "--theme path does not exist: /no/such. No theme was loaded from it." },
		]);
		expect(missingCliPathWarnings("--prompt-template", "prompt template", ["/no/such.md"])[0]?.message).toContain(
			"--prompt-template path does not exist: /no/such.md",
		);
	});

	it("stays silent for a path that exists, a package source and no flag at all", () => {
		const file = join(mkdtempSync(join(tmpdir(), "cli-path-")), "t.json");
		writeFileSync(file, "{}");
		expect(missingCliPathWarnings("--theme", "theme", [file, "npm:some-themes"])).toEqual([]);
		expect(missingCliPathWarnings("--theme", "theme", undefined)).toEqual([]);
	});
});
