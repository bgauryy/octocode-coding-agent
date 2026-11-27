import { expect, it } from "vitest";
import { agentToolSpec } from "../../src/octocode/native/tools/agent/spec.ts";

it("does not expose a collaboration opt-in parameter", () => {
	expect(agentToolSpec().parameters.properties).not.toHaveProperty("collaborate");
});
