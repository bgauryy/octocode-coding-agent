import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallEvent } from "../../src/core/features/index.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { runsLater, shellTargetAccess } from "../../src/octocode/permission/file-access.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { browserMcpRequest } from "../../src/octocode/web/browser-mcp.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A bash command cannot change a curated MEMORY.md around the `memory` tool, in any mode; reading it stays allowed. */

const MEMORY = ".octocode/octocodecode/MEMORY.md";
const bash = (command: string) =>
	({ type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command } }) as ToolCallEvent;

beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", path.join(tmp("memhome-"), "home"));
	vi.stubEnv("OCTOCODE_SUBAGENT", "");
});
afterEach(() => vi.unstubAllEnvs());

function setup(mode: "workspace" | "full") {
	const cwd = fs.realpathSync(tmp());
	fs.mkdirSync(path.join(cwd, ".git"));
	fs.mkdirSync(path.dirname(path.join(cwd, MEMORY)), { recursive: true });
	fs.writeFileSync(path.join(cwd, MEMORY), "## Decisions\n- keep this\n");
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI: true, ui: { selects: [] } });
	permission.start(ctx);
	const gate = permissionGate({
		permission,
		provenance: { check: () => undefined },
		powershell: async () => false,
		network: (toolName, input) => browserMcpRequest(toolName, input),
	});
	return { cwd, ctx, gate };
}

describe("bash and the MEMORY.md files", () => {
	it("refuses a write or a delete of the workspace MEMORY.md in every mode, naming the memory tool", async () => {
		await shellParserReady();
		for (const mode of ["workspace", "full"] as const) {
			const { ctx, gate } = setup(mode);
			for (const command of [`echo x > ${MEMORY}`, `rm ${MEMORY}`, `cp /dev/null ${MEMORY}`])
				expect(await gate(bash(command), ctx), `${mode}: ${command}`).toMatchObject({
					block: true,
					reason: expect.stringMatching(/curated memory file.*`memory` tool/),
				});
			expect(fs.readFileSync(path.join(ctx.cwd, MEMORY), "utf8")).toBe("## Decisions\n- keep this\n");
		}
	});

	it("refuses the global MEMORY.md as well", async () => {
		await shellParserReady();
		const { ctx, gate } = setup("full");
		const global = path.join(process.env.OCTOCODE_HOME!, "MEMORY.md");
		expect(await gate(bash(`echo x >> ${global}`), ctx)).toMatchObject({ block: true });
	});

	it("lets a read of the file run", async () => {
		await shellParserReady();
		const { ctx, gate } = setup("workspace");
		expect(await gate(bash(`cat ${MEMORY}`), ctx)).toBeUndefined();
		expect(
			shellTargetAccess({ kind: "read", raw: MEMORY, path: MEMORY, position: 0 }, ctx.cwd).refusal,
		).toBeUndefined();
	});

	it("counts the folder as loaded by later sessions", () => {
		const { cwd } = setup("workspace");
		expect(runsLater(path.join(cwd, ".octocode/octocodecode/notes.md"), cwd)).toBe(true);
		expect(runsLater(path.join(cwd, ".octocode/tmp/notes.md"), cwd)).toBe(false);
	});
});
