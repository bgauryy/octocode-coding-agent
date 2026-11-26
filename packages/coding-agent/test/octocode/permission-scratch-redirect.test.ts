import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A checkout with a package folder: `../../.octocode/agent/tmp/x` and its absolute spelling name one file. */
function checkout(at = "packages/app", octocodeHomeTwoUp = false) {
	const base = fs.realpathSync(tmp());
	// Two folders above this root lies the Octocode home, as for a checkout at ~/code/project and the home ~/.octocode.
	if (octocodeHomeTwoUp) vi.stubEnv("OCTOCODE_HOME", path.join(base, ".octocode"));
	const root = octocodeHomeTwoUp ? path.join(base, "code", "project") : base;
	fs.mkdirSync(path.join(root, "packages", "app"), { recursive: true });
	fs.mkdirSync(path.join(root, ".git"));
	const cwd = path.join(root, at);
	fs.mkdirSync(cwd, { recursive: true });
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: "workspace" }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: false });
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
	let id = 0;
	const run = (command: string) =>
		gate({ type: "tool_call", toolCallId: `s${id++}`, toolName: "bash", input: { command } }, ctx);
	return { root, run };
}

// An unclosed parameter expansion is a syntax error: the parse gives up (as on a loaded machine) and the guard reads the command's words.
const UNPARSED = "; echo ${";

afterEach(() => vi.unstubAllEnvs());

/** Whether the gate refused as Octocode's state folder (a call it cannot place asks instead, which no one answers here). */
const stateRefused = (result: { block?: boolean; reason?: string } | undefined): boolean =>
	result?.block === true && /state folder/.test(result.reason ?? "");

describe("a redirect into .octocode/agent/tmp", () => {
	it("is judged the same relative and absolute", async () => {
		const { root, run } = checkout();
		const absolute = path.join(root, ".octocode", "agent", "tmp", "suite.txt");
		expect(await run(`echo hi > ${absolute}`)).toBeUndefined();
		expect(await run("echo hi > ../../.octocode/agent/tmp/suite.txt")).toBeUndefined();
		expect(await run("echo hi > ../../.octocode/agent/./tmp/suite.txt")).toBeUndefined();
		expect(await run("true && yarn test > ../../.octocode/agent/tmp/suite.txt")).toBeUndefined();
	});

	it.each(["../../.octocode/agent/backlog.md", "../../.octocode/agent/sessions/x"])(
		"still refuses the state folder spelled %s",
		async (spelling) => {
			const { root, run } = checkout();
			const relative = await run(`echo hi > ${spelling}`);
			const absolute = await run(`echo hi > ${path.join(root, spelling.replace("../../", ""))}`);
			expect(relative).toMatchObject({ block: true });
			expect(absolute).toMatchObject({ block: true });
		},
	);

	it("is judged the same when the parse gives up, after a cd", async () => {
		const { root, run } = checkout(".", true);
		const app = path.join(root, "packages", "app");
		const scratch = "../../.octocode/agent/tmp/suite.txt";
		expect(stateRefused(await run(`cd ${app} && mkdir -p ${scratch} && yarn test > ${scratch} 2>&1${UNPARSED}`))).toBe(
			false,
		);
		expect(stateRefused(await run(`cd packages/app && yarn test > ${scratch}${UNPARSED}`))).toBe(false);
		expect(stateRefused(await run(`yarn test > ${path.join(root, ".octocode/agent/tmp/suite.txt")}${UNPARSED}`))).toBe(
			false,
		);
	});

	it("still refuses the state folder when the parse gives up, after a cd", async () => {
		const { root, run } = checkout(".", true);
		const app = path.join(root, "packages", "app");
		const state = "../../.octocode/agent/backlog.md";
		const absolute = path.join(root, ".octocode/agent/backlog.md");
		for (const command of [
			`cd ${app} && yarn test > ${state}${UNPARSED}`,
			`cd ${app} && (yarn test > ${state})${UNPARSED}`,
			`cd ${app} ; yarn test > ${absolute}${UNPARSED}`,
		])
			expect(stateRefused(await run(command))).toBe(true);
	});
});

describe("scratch under the global agent state store", () => {
	it("runs the V8 line, and one that logs into the global tmp/ and temp/ folders", async () => {
		const { root, run } = checkout(".", true);
		expect(await run("cd packages/app && x=$(ls) && echo hi > ../../.octocode/agent/tmp/x.log")).toBeUndefined();
		expect(stateRefused(await run("echo hi > ../../.octocode/agent/temp/x.log"))).toBe(false);
		const absolute = path.join(root, "..", "..", ".octocode", "agent", "tmp", "x.log");
		expect(stateRefused(await run(`echo hi > ${absolute}`))).toBe(false);
	});

	it.each(["workspaces.db", "sessions/x", "temp/sessions/x"])(
		"still refuses the global %s and shows the resolved path",
		async (name) => {
			const { root, run } = checkout(".", true);
			const result = await run(`echo hi > ../../.octocode/agent/${name}`);
			expect(result).toMatchObject({ block: true });
			expect(result?.reason).toContain(`../../.octocode/agent/${name}`);
			expect(result?.reason).toContain(path.join(root, "..", "..", ".octocode", "agent", name));
		},
	);
});
