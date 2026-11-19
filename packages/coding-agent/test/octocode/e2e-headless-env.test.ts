import { afterEach, expect, it } from "vitest";
import { disposeSessions, headless, restoreEnv } from "./e2e-headless.ts";

afterEach(() => {
	disposeSessions();
	restoreEnv();
});

it("runs the headless session offline, so no startup download runs", async () => {
	await headless();
	expect(process.env.OCTOCODE_OFFLINE).toBe("1");
	expect(process.env.OCTOCODE_MCP).toBe("0");
});
