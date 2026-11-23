import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { asksUnsandboxed } from "../../src/octocode/native/tools/bash/unsandboxed.ts";
import { setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import { nativeCall } from "./e2e-calls.ts";
import { disposeSessions, headless, restoreEnv, say } from "./e2e-headless.ts";

/**
 * `sandbox.allowUnsandboxed: false` (S2): a call's `sandbox` field is coerced by validation (`"false"`, `0` and `"0"`
 * become `false`) after `prepareArguments` runs, so the gate must read it as validation will. Only `true` or an absent
 * field keeps a command sandboxed.
 */
const outsideDirs: string[] = [];
afterEach(() => {
	disposeSessions();
	setCommandSandbox(undefined);
	for (const dir of outsideDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(restoreEnv);

describe("asksUnsandboxed", () => {
	it("reads every value validation coerces to false as a request to run outside the sandbox", () => {
		for (const value of [false, "false", "FALSE", 0, "0", "no", ""])
			expect(asksUnsandboxed(value), String(value)).toBe(true);
		for (const value of [undefined, null, true, "true", 1, "1"])
			expect(asksUnsandboxed(value), String(value)).toBe(false);
	});
});

describe.runIf(process.platform === "darwin")("bash with sandbox.allowUnsandboxed: false", () => {
	for (const mode of ["bypass", "full"]) {
		it(`refuses sandbox: false spelled as a string or number in ${mode} mode, without asking`, async () => {
			// Outside the workspace and the system temporary folders the policy opens.
			const outside = fs.mkdtempSync(path.join("/private/var/tmp", "octocode-unsandboxed-"));
			outsideDirs.push(outside);
			const { run, audit } = await headless({
				env: { OCTOCODE_PERMISSION: mode },
				setup: ({ root }) => {
					fs.mkdirSync(path.join(root, "agent"), { recursive: true });
					fs.writeFileSync(
						path.join(root, "agent", "settings.json"),
						JSON.stringify({ sandbox: { mode: "on", allowUnsandboxed: false } }),
					);
				},
			});
			const spellings: unknown[] = [false, "false", 0, "0"];
			const turns = await run("go", [
				...spellings.map(
					(sandbox, index) => () =>
						fauxAssistantMessage(
							[nativeCall("bash", { command: `touch '${path.join(outside, `f${index}`)}'`, sandbox })],
							{ stopReason: "toolUse" },
						),
				),
				say("done"),
			]);
			expect(fs.readdirSync(outside)).toEqual([]);
			for (const turn of turns.slice(1, 1 + spellings.length))
				expect(turn[0]?.text).toContain("sandbox.allowUnsandboxed setting is false");
			expect(audit().filter((entry) => entry.action === "shell.unsandboxed")).toEqual([]);
		}, 60_000);
	}
});
