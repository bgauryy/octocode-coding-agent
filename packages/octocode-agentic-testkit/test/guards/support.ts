import "../bundle.ts";
import type { TestContext } from "vitest";
import { octocodecodeAvailable } from "../../src/adapters/octocodecode/index.ts";

/** Skip locally when the bundle is missing; fail under CI=1 so a guard never silently vanishes. */
export function requireBundle(ctx: TestContext): void {
	if (octocodecodeAvailable()) return;
	if (process.env.CI === "1")
		throw new Error("octocodecode bundle missing: build the bundle first (yarn run build:offline)");
	ctx.skip("octocodecode bundle missing: run `yarn run build:offline` first");
}
