import { describe, expect, it } from "vitest";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { PERMISSION_ENV, PERMISSION_GRANTS_ENV } from "@octocodeai/octocode-common/env";
import { askSpawn } from "../../src/octocode/subagents/profiles.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * One spawn approval in `manual` grants the profile's reach for the child's whole run. That is the documented design
 * (the dialog names the reach), so this pins its exact extent: the two reach classes, and nothing that always asks.
 */
describe("what a spawn approval in manual mode grants the child", () => {
	it("grants shell and workspace edits for the run, and never outside changes or destructive shell", async () => {
		const parent = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: "manual" }, isSubagent: false });
		const ctx = fakeCtx({ cwd: tmp(), ui: { selects: ["Allow once"] } });
		parent.start(ctx);
		const profile = { name: "implementer", description: "", prompt: "" };
		const grants = await askSpawn(parent, ctx, profile, "Fix the bug");
		expect(grants).toEqual(["file.workspace", "shell"]);

		// The child runs in the parent's mode with those grants; it cannot ask anyone.
		const child = new Permission({
			api: fakeHost().api,
			env: { [PERMISSION_ENV]: parent.mode, [PERMISSION_GRANTS_ENV]: grants.join(",") },
			isSubagent: true,
		});
		const childCtx = fakeCtx({ cwd: tmp(), hasUI: false });
		child.start(Object.assign(childCtx, { isProjectTrusted: () => false }));
		const ask = (action: "shell" | "file.workspace" | "file.outside" | "shell.destructive") =>
			child.check(childCtx, { action, title: "x", what: ["x"] });
		expect(await ask("shell")).toMatchObject({ allowed: true, via: "grant" });
		expect(await ask("file.workspace")).toMatchObject({ allowed: true, via: "grant" });
		expect(await ask("file.outside")).toMatchObject({ allowed: false });
		expect(await ask("shell.destructive")).toMatchObject({ allowed: false });
	});

	it("passes no grant when the parent's mode already allows the spawn", async () => {
		const parent = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: "workspace" }, isSubagent: false });
		const ctx = fakeCtx({ cwd: tmp() });
		parent.start(ctx);
		expect(await askSpawn(parent, ctx, { name: "implementer", description: "", prompt: "" }, "Fix")).toEqual([]);
	});
});
