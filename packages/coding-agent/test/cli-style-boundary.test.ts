import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliStyle, disableCliColor } from "../src/utils/cli-style.ts";

const SOURCE = join(import.meta.dirname, "..", "src");
const CLI_STYLE = join(SOURCE, "utils", "cli-style.ts");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

describe("cliStyle", () => {
	it("is the only module that imports chalk, so command-line color has one owner", () => {
		const offenders = sources(SOURCE).filter(
			(file) => file !== CLI_STYLE && /from\s+["']chalk["']/.test(readFileSync(file, "utf-8")),
		);
		expect(offenders).toEqual([]);
	});

	it("styles by role and goes plain once color is disabled", () => {
		expect(cliStyle.heading("x")).toBe(cliStyle.heading("x"));
		disableCliColor();
		for (const role of Object.values(cliStyle)) expect(role("plain")).toBe("plain");
	});
});
