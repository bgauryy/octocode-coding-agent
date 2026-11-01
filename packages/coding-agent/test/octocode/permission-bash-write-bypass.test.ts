import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceRefusal } from "../../src/octocode/files/tool/run.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { PERMISSION_ENV } from "../../../common/src/env.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * Workspace mode runs shell commands unasked but asks before a write outside the workspace. Each command below writes
 * outside it (or somewhere the parse cannot place) through a form the write parse used to misread; with no UI the ask
 * becomes a refusal, so a block proves the gate asked. The controls are everyday commands that must keep running.
 */
function workspace() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: "workspace" }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: false });
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
	let id = 0;
	const run = (command: string) =>
		gate({ type: "tool_call", toolCallId: `b${id++}`, toolName: "bash", input: { command } }, ctx);
	return { cwd, ctx, permission, run };
}

const outside = path.join(os.homedir(), ".octocode-br1-never-written");

describe("bash writes outside the workspace ask in workspace mode", () => {
	it.each([
		// A wrapper option the parse took for a value (or did not know) hid the command it runs.
		["xargs --replace takes no value", `echo | xargs --replace cp cat ${outside}`],
		["BSD env -P takes a value", `env -P /bin cp a ${outside}`],
		["flock -w takes a value", `flock -w 5 lockfile cp a ${outside}`],
		["flock -c runs a shell string", `flock lockfile -c 'cp a ${outside}'`],
		["an unknown uv option", `uv run --with requests cp a ${outside}`],
		["npx -c runs a shell string", `npx -c 'cp a ${outside}'`],
		["watch runs its command", `watch -n1 cp a ${outside}`],
		["npm exec runs its command", `npm exec -- cp a ${outside}`],
		// Destinations spelled in forms the parse did not read.
		["--target-directory=dir", "cp --target-directory=/tmp a"],
		["mv --target-directory=dir", "mv --target-directory=/tmp a"],
		["~user expands to that user's home", "cp a ~root/.zshrc"],
		["brace expansion makes an absolute word", `cp {a,${outside}}`],
		["a hard link makes its source writable", `ln ${outside} inside`],
		["link is a hard link", `link ${outside} inside`],
		["patch -o", `patch -o ${outside} a p.diff`],
		["mkfifo", `mkfifo ${outside}`],
		// Readers whose options write a file or run a program.
		["sort -o", `sort -o ${outside} a`],
		["uniq output operand", `uniq a ${outside}`],
		["tree -o", `tree -o ${outside}`],
		["git diff --output", `git diff --output=${outside}`],
		["rg --pre runs a program", "rg --pre ./x a"],
	])("%s", async (_why, command) => {
		const { run } = workspace();
		expect(await run(command)).toMatchObject({ block: true });
	});

	it.each([
		"sudo -E npm test",
		"xargs -0 grep x",
		"timeout 5 npm test",
		"npx tsc --noEmit",
		"nice -n 5 make",
		"env A=1 node x.js",
		"sort -o out.txt a",
		"git diff --output=out.txt",
		"cp -t dir a",
		"cp --target-directory=dir a",
		"find . -name x -exec cp {} dir \\;",
		"npm exec -- tsc",
		"ln -s ../shared link",
		"ln a b",
	])("still runs `%s` unasked", async (command) => {
		const { run } = workspace();
		expect(await run(command)).toBeUndefined();
	});
});

describe("a hard-linked workspace path is a change outside the workspace", () => {
	function linked() {
		const env = workspace();
		const elsewhere = path.join(tmp(), "outside.txt");
		fs.writeFileSync(elsewhere, "x");
		fs.linkSync(elsewhere, path.join(env.cwd, "inside.txt"));
		fs.writeFileSync(path.join(env.cwd, "plain.txt"), "x");
		return env;
	}

	it("asks before a bash redirect into it, not into a plain file", async () => {
		const { run } = linked();
		expect(await run("echo y >> inside.txt")).toMatchObject({ block: true });
		expect(await run("echo y >> plain.txt")).toBeUndefined();
	});

	it("asks before the file tool changes it, not a plain file", async () => {
		const { cwd, ctx, permission } = linked();
		const change = (name: string) =>
			workspaceRefusal(
				path.join(cwd, name),
				{ type: "write", path: name, content: "y" } as Parameters<typeof workspaceRefusal>[1],
				ctx as never,
				undefined,
				permission,
				"f1",
			);
		expect(await change("inside.txt")).toMatch(/outside the workspace/);
		expect(await change("plain.txt")).toBeUndefined();
	});
});
