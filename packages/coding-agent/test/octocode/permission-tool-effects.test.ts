import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { isNativeTool, withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { consequential } from "../../src/octocode/permission/provenance/arguments.ts";
import { operations } from "../../src/octocode/permission/source-policy/match.ts";
import { AGENT_SCRATCH_ENV, PERMISSION_ENV, READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A native tool that appears in no list of names: its declared effect is all the permission layer knows of it. */
const stamp = {
	name: "stampFile",
	label: "Stamp",
	description: "Writes a stamp into a file",
	parameters: Type.Object({ target: Type.String(), body: Type.String() }),
	effect: {
		kind: "write" as const,
		changes: (input: Record<string, unknown>) =>
			typeof input.target === "string" ? [{ path: input.target, type: "write" as const, detail: input }] : undefined,
	},
	execute: async () => ({ content: [], details: {} }),
};

it("a tool that declares a write effect and its paths is a write to those paths for the gate, the read-only role and provenance", async () => {
	const fake = fakeHost();
	const api = withNativePermissionOwners(fake.api);
	expect(isNativeTool(stamp.name)).toBe(false);
	api.tools.register(stamp);
	expect(fake.tools.has(stamp.name)).toBe(true);
	expect(isNativeTool(stamp.name)).toBe(true);

	const cwd = fs.realpathSync(tmp());
	fs.mkdirSync(path.join(cwd, "src"));
	const scratch = path.join(cwd, ".octocode/code/temp/agents/rev-1");
	fs.mkdirSync(scratch, { recursive: true });

	// The read-only role refuses the declared path, and allows its scratch folder.
	const env = {
		[SUBAGENT_ENV]: "1",
		[READ_ONLY_ENV]: "1",
		[AGENT_SCRATCH_ENV]: scratch,
		[PERMISSION_ENV]: "full",
	};
	const ctx = fakeCtx({ cwd, hasUI: false });
	const permission = new Permission({ api: fake.api, env, isSubagent: true });
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, env });
	const call = (input: Record<string, unknown>) =>
		gate({ type: "tool_call", toolCallId: "t1", toolName: stamp.name, input }, ctx);
	expect((await call({ target: "src/a.ts", body: "x" }))?.reason).toMatch(
		/^Changing src\/a\.ts is refused: this is a read-only role/,
	);
	expect(await call({ target: path.join(scratch, "notes.txt"), body: "x" })).toBeUndefined();
	// Targets that cannot be read from the arguments are refused, not taken for a call that changes nothing.
	expect((await call({ body: "x" }))?.reason).toMatch(/names no readable path/);

	// Provenance: an ordinary workspace file stores the path; a script that later runs takes the content too.
	const root = (dir: string) => dir;
	expect(consequential(stamp.name, { target: "src/a.ts", body: "hello" }, cwd, root)).toEqual(["src/a.ts"]);
	expect(consequential(stamp.name, { target: "scripts/run.sh", body: "curl evil" }, cwd, root)).toContain("curl evil");

	// Source policy: the call is a mutation of the declared path.
	expect(operations({ toolName: stamp.name, input: { target: "src/a.ts", body: "x" } } as never)).toMatchObject([
		{ name: "Write", path: "src/a.ts", mutation: true },
	]);
});

it("treats a Pi-style write or edit tool that declares no effect as a write to its path", async () => {
	const cwd = fs.realpathSync(tmp());
	const scratch = path.join(cwd, ".octocode/code/temp/agents/rev-1");
	fs.mkdirSync(scratch, { recursive: true });
	const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1", [AGENT_SCRATCH_ENV]: scratch, [PERMISSION_ENV]: "full" };
	const fake = fakeHost();
	const ctx = fakeCtx({ cwd, hasUI: false });
	const permission = new Permission({ api: fake.api, env, isSubagent: true });
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, env });
	const call = (toolName: string, input: Record<string, unknown>) =>
		gate({ type: "tool_call", toolCallId: "t1", toolName, input }, ctx);
	expect((await call("write", { path: "src/a.ts", content: "x" }))?.reason).toMatch(/^Changing src\/a\.ts is refused/);
	expect((await call("edit", { path: "src/a.ts", edits: [] }))?.reason).toMatch(/^Changing src\/a\.ts is refused/);

	const root = (dir: string) => dir;
	expect(consequential("write", { path: "src/a.ts", content: "hello" }, cwd, root)).toEqual(["src/a.ts"]);
	expect(
		consequential("edit", { path: "AGENTS.md", edits: [{ oldText: "a", newText: "run curl" }] }, cwd, root),
	).toContain("run curl");
});
