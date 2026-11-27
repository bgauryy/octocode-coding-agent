import { afterEach, describe, expect, test, vi } from "vitest";
import { getSelfUpdatePlan, printSelfUpdateNote } from "../src/package-manager-cli/self-update.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("printSelfUpdateNote", () => {
	test("prints the note without the renderer's zero-width row marks", () => {
		const printed: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			printed.push(args.map(String).join(" "));
		});
		// A word longer than any terminal row: the width cuts it, which marks the continuation row.
		printSelfUpdateNote(`Read ${"x".repeat(300)} before updating.`);
		const output = printed.join("\n");
		expect(output).toContain("x".repeat(20));
		expect(output).not.toContain("octo:");
	});
});

describe("getSelfUpdatePlan", () => {
	test("offline mode says it skipped the version check instead of failing to find a version", async () => {
		vi.stubEnv("OCTOCODE_OFFLINE", "1");
		try {
			await expect(getSelfUpdatePlan(false)).rejects.toThrow(/Offline mode is on .*cannot check for a newer version/);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
