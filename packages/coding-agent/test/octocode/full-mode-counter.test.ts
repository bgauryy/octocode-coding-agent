import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { expect, it, vi } from "vitest";
import { withInputOrigin } from "../../src/core/input-origin.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { userBashGate } from "../../src/octocode/permission/user-bash.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const bang = (command: string, cwd: string) => ({
	type: "user_bash" as const,
	command,
	excludeFromContext: false,
	cwd,
});

it("counts what the agent ran in full mode, never the user's own `!` commands", async () => {
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: "full" }, isSubagent: false });
	permission.start(ctx);
	const gate = permissionGate({ permission, provenance: { check: () => undefined }, powershell: async () => false });
	const userBash = userBashGate({ permission, preToolUse: async () => undefined, clientPermission: gate });
	const typed = vi.spyOn(permission, "typed");
	const check = vi.spyOn(permission, "check");

	// Typed at the terminal (consent by typing), a destructive one (checked, still the user's) and one from the web page
	// (judged by the same gate as an agent's call). The gate only judges: nothing runs.
	await userBash(bang("printf hello", ctx.cwd), ctx);
	await userBash(bang("rm -rf ~", ctx.cwd), ctx);
	await withInputOrigin("web", () => userBash(bang("touch from-web", ctx.cwd), ctx));
	expect(typed).toHaveBeenCalledTimes(1);
	expect(check).toHaveBeenCalledTimes(2);
	expect(permission.count).toEqual({ actions: 0, warnings: 0 });

	await gate(
		{ type: "tool_call", toolCallId: "agent-1", toolName: "bash", input: { command: "touch from-agent" } },
		ctx,
	);
	expect(permission.count).toEqual({ actions: 1, warnings: 0 });
});
