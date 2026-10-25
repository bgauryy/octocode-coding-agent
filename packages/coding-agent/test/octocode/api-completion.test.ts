import { describe, expect, it } from "vitest";
import { completeApi } from "../../src/octocode/api/completion.ts";
import { shellCompletion } from "../../src/octocode/shared/shell-completion.ts";

describe("API CLI completions", () => {
	it("offers live instance IDs, send modes and comma-separated watch events", () => {
		expect(completeApi(["status", "--to", "pi-a"], ["pi-abc", "pi-def"])).toEqual(["pi-abc"]);
		expect(completeApi(["send", "--mode", ""])).toEqual(["steer", "followUp"]);
		expect(completeApi(["watch", "--types", "turn.start,message.d"])).toContain("turn.start,message.delta");
		expect(completeApi(["send", "--from", ""])).toEqual([]);
		expect(completeApi(["send", "hello"])).toEqual([]);
		expect(completeApi(["constructor", ""])).toEqual([]);
	});
	it("offers guarded send and event replay flags without completing free-form values or message text", () => {
		expect(completeApi(["send", "--"])).toEqual(
			expect.arrayContaining(["--key", "--session", "--timeout", "--require-idle"]),
		);
		expect(completeApi(["watch", "--si"])).toEqual(["--since"]);
		for (const flag of ["--key", "--session", "--timeout"]) expect(completeApi(["send", flag, ""])).toEqual([]);
		expect(completeApi(["watch", "--since", ""])).toEqual([]);
		expect(completeApi(["send", "--", "--to"], ["pi-one"])).toEqual([]);
	});
	it("uses distinct shell functions for the two executables", () => {
		for (const shell of ["bash", "zsh", "fish"] as const) {
			expect(shellCompletion(shell, "octocode-api")).toContain("_octocode_api_complete");
			expect(shellCompletion(shell, "octocode")).not.toContain("_octocode_api_complete");
		}
	});
});

it("does not prune stale instance records while completing", async () => {
	const fs = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { listInstances, writeRecord, instancesDir } = await import("../../src/octocode/api/registry.ts");
	const dir = fs.mkdtempSync(join(tmpdir(), "api-completion-"));
	try {
		writeRecord(dir, { id: "stale", pid: 99999999, cwd: dir, startedAt: 0, protocol: 1 });
		expect(listInstances(dir, false)).toEqual([]);
		expect(fs.readdirSync(instancesDir(dir))).toEqual(["stale.json"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
