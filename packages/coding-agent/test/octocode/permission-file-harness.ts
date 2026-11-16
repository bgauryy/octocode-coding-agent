import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/**
 * The real `file` tool under a real permission mode, with nobody to ask: a write the mode asks about is refused, as in a
 * headless run. `write` returns the tool's rejection text, or undefined when the change was applied.
 */
export function headlessFileTool(mode: PermissionMode, cwd: string, options: { isSubagent?: boolean } = {}) {
	const fake = fakeHost();
	const permission = new Permission({
		api: fake.api,
		env: { [PERMISSION_ENV]: mode },
		isSubagent: options.isSubagent ?? false,
		stderr: () => undefined,
	});
	const ctx = fakeCtx({ cwd, hasUI: false });
	permission.start(ctx);
	registerFileTool(fake.api, new FileGuard(), permission);
	const tool = fake.tools.get("file")!;
	return {
		async write(target: string, content = "x"): Promise<string | undefined> {
			try {
				await tool.execute(
					"c",
					{ reason: "test", queries: [{ reason: "test", type: "write", path: target, content }] },
					undefined,
					undefined,
					ctx,
				);
				return undefined;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	};
}
