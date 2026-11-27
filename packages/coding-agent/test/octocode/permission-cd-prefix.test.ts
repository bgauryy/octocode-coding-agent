import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * `builtin cd` and `command cd` change the directory like a bare `cd`, so a relative write after them may land outside
 * the workspace. Workspace mode must ask (with no UI an ask is a refusal); the followable forms keep running unasked.
 */
function workspaceGate() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: "workspace" }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: false });
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
	let id = 0;
	return (command: string) =>
		gate({ type: "tool_call", toolCallId: `c${id++}`, toolName: "bash", input: { command } }, ctx);
}

describe("a cd behind builtin or command", () => {
	it.each([
		"builtin cd ~ && echo x > .zshrc",
		"command cd ~ && echo x > .zshrc",
		"command -p cd ~ && echo x > .zshrc",
		"builtin cd ~; cp a .zshrc",
		"command pushd ~ && echo x > .zshrc",
	])("asks before %j", async (command) => {
		expect((await workspaceGate()(command))?.block).toBe(true);
	});

	it.each([
		"builtin cd ./sub && echo x > f",
		"command cd ./sub && echo x > f",
		"command -v cd && echo x > f",
		"builtin echo cd > f",
	])("runs %j unasked", async (command) => {
		expect(await workspaceGate()(command)).toBeUndefined();
	});
});
