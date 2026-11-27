import fs from "node:fs";
import path from "node:path";
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

	it("shows no desktop text, no desktop profile and no `apps` field to a session without Cua Driver", () => {
		// The committed prompts are captured with the server off, which is how a machine without `cua-driver` runs.
		const finalDir = path.join(import.meta.dirname, "../../src/octocode/native/prompts/final");
		for (const file of fs.readdirSync(finalDir).filter((name) => name.endsWith(".md"))) {
			const text = fs.readFileSync(path.join(finalDir, file), "utf8");
			expect(text, file).not.toMatch(/\bdesktop\b/i);
			expect(text, file).not.toMatch(/"apps"|\bapps\b.*only apps it may control/i);
		}
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
