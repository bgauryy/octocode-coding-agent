import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS, baseEnv, fixture } from "./agent-context/capture.ts";

afterEach(() => vi.unstubAllEnvs());

describe("the opt-in desktop capture", () => {
	it("leaves the committed capture alone: the desktop server stays off and no desktop agent is captured", () => {
		vi.stubEnv("OCTOCODE_CAPTURE_DESKTOP", "");
		const fx = fixture();
		try {
			expect(baseEnv(fx).OCTOCODE_MCP_DESKTOP).toBe("0");
			expect(baseEnv(fx).HOME).toBe(fx.home);
		} finally {
			fs.rmSync(fx.root, { recursive: true, force: true });
		}
		expect(AGENTS.map((agent) => agent.name)).not.toContain("desktop");
	});

	it("keeps the server on when OCTOCODE_CAPTURE_DESKTOP=1", () => {
		vi.stubEnv("OCTOCODE_CAPTURE_DESKTOP", "1");
		const fx = fixture();
		try {
			expect(baseEnv(fx).OCTOCODE_MCP_DESKTOP).toBeUndefined();
			expect(baseEnv(fx).OCTOCODE_CAPTURE_DESKTOP).toBe("1");
		} finally {
			fs.rmSync(fx.root, { recursive: true, force: true });
		}
	});
});
