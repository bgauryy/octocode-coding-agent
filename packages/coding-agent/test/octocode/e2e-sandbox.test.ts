import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setCommandSandbox } from "../../src/utils/command-sandbox.ts";
import { nativeCall } from "./e2e-calls.ts";
import { disposeSessions, headless, restoreEnv, say } from "./e2e-headless.ts";

/**
 * `sandbox.mode: "on"` through a real headless session: the scripted model's `bash` call runs a program that writes by
 * itself, which the permission gate cannot see, and the operating system decides.
 */
const outsideDirs: string[] = [];

afterEach(() => {
	disposeSessions();
	setCommandSandbox(undefined);
	for (const dir of outsideDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(restoreEnv);

const bash = (command: string) => nativeCall("bash", { command });
const writer = (target: string) => `node -e "require('fs').writeFileSync(process.argv[1],'1')" '${target}'`;

async function start(sandbox: "on" | "off") {
	// Outside the workspace and outside the system temporary folders the policy opens.
	const outside = fs.mkdtempSync(path.join("/private/var/tmp", "octocode-e2e-sandbox-"));
	outsideDirs.push(outside);
	const session = await headless({
		env: { OCTOCODE_PERMISSION: "full" },
		setup: ({ root }) => {
			fs.mkdirSync(path.join(root, "agent"), { recursive: true });
			fs.writeFileSync(path.join(root, "agent", "settings.json"), JSON.stringify({ sandbox: { mode: sandbox } }));
		},
	});
	return { ...session, outside };
}

describe.runIf(process.platform === "darwin")("bash with sandbox.mode on", () => {
	it("fails a program's write outside the workspace with EPERM and allows one inside", async () => {
		const { cwd, outside, run } = await start("on");
		const [, after] = await run("go", [
			() =>
				fauxAssistantMessage([bash(writer(path.join(outside, "x"))), bash(writer(path.join(cwd, "inside.txt")))], {
					stopReason: "toolUse",
				}),
			say("done"),
		]);
		expect(after).toHaveLength(2);
		expect(after[0]?.text).toContain("EPERM");
		expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
		expect(fs.readFileSync(path.join(cwd, "inside.txt"), "utf8")).toBe("1");
	});
});

describe("bash with the default sandbox.mode off", () => {
	it.runIf(process.platform === "darwin")("writes outside the workspace as before", async () => {
		const { outside, run } = await start("off");
		await run("go", [
			() => fauxAssistantMessage([bash(writer(path.join(outside, "x")))], { stopReason: "toolUse" }),
			say("done"),
		]);
		expect(fs.existsSync(path.join(outside, "x"))).toBe(true);
	});
});
