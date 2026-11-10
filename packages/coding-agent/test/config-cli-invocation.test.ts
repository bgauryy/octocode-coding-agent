// A process started from the bundle starts its children (subagents, forks) from the bundle too, so a peer's
// half-saved edit under src/ cannot crash them at startup; a source process keeps starting source children.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import { getPackageDir } from "../src/install/package-detection.ts";

const packageDir = getPackageDir();
const bundleCli = join(packageDir, "dist", "bundle", "cli.js");
const sourceCli = join(packageDir, "src", "cli.ts");
const entry = process.argv[1];
afterEach(() => {
	process.argv[1] = entry!;
});

describe("getCliInvocation in a checkout", () => {
	it.skipIf(!existsSync(bundleCli))("starts the bundle when this process runs the bundle", () => {
		process.argv[1] = bundleCli;
		expect(getCliInvocation()).toEqual({ command: process.execPath, prefix: [bundleCli] });
	});

	it("starts the source entry when this process runs the source entry", () => {
		process.argv[1] = sourceCli;
		expect(getCliInvocation().prefix.at(-1)).toBe(sourceCli);
	});

	it("starts the source entry from any other host (a test runner)", () => {
		process.argv[1] = join(packageDir, "node_modules", ".bin", "vitest");
		expect(getCliInvocation().prefix.at(-1)).toBe(sourceCli);
	});
});
