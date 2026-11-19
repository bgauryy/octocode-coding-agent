import "../bundle.ts";
import type { TestContext } from "vitest";
import { octocodeAgentAvailable } from "../../src/adapters/octocode-agent/index.ts";

/** Skip locally when the bundle is missing; fail under CI=1 so a guard never silently vanishes. */
export function requireBundle(ctx: TestContext): void {
	if (octocodeAgentAvailable()) return;
	if (process.env.CI === "1")
		throw new Error("octocode-agent bundle missing: build the bundle first (yarn run build:offline)");
	ctx.skip("octocode-agent bundle missing: run `yarn run build:offline` first");
}
