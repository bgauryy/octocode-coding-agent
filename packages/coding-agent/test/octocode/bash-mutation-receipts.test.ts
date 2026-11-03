import { describe, expect, it } from "vitest";
import { registerBashTool } from "../../src/octocode/files/bash.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { recordShellMutation } from "../../src/octocode/files/bash/mutation.ts";
import { currentMutationRevision, recordMutation } from "../../src/octocode/files/feedback/revisions.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let counter = 0;
const session = () => `shell-mutation-${++counter}`;

describe("a mutating shell command stales verification receipts", () => {
	it("counts changes inside the workspace, and only those", async () => {
		const cwd = tmp();
		const id = session();
		const changed = async (command: string, powershell = false) => {
			const before = currentMutationRevision(id);
			await recordShellMutation(command, cwd, id, powershell);
			return currentMutationRevision(id) !== before;
		};
		for (const command of ["sed -i s/a/b/ f.txt", "echo x > out.txt", "git commit -m x", "npm install", "rm f.txt"])
			expect(await changed(command), command).toBe(true);
		for (const command of [
			"git status && git diff",
			"yarn tsc --noEmit",
			"ls | wc -l",
			"echo x > /tmp/outside.txt",
			"echo x > .octa/code/temp/notes.md",
			"yarn test 2>&1 | tail -n 20",
		])
			expect(await changed(command), command).toBe(false);
		expect(await changed("Set-Content f.txt x", true)).toBe(true);
		expect(await changed("Get-ChildItem", true)).toBe(true);
		expect(await changed("ls", true)).toBe(false);
	});

	it("through the bash tool: an edit after a passing check makes it stale, the check's own writes do not", async () => {
		const { api, tools } = fakeHost();
		registerBashTool(api, new Subcommands(), new BashJobs(tmp()), () => ({}));
		const tool = tools.get("bash");
		const cwd = tmp();
		const id = session();
		const ctx = fakeCtx({ cwd });
		Object.assign(ctx.sessionManager, { getSessionId: () => id });
		const run = (params: Record<string, unknown>) => tool.execute("t", params, undefined, undefined, ctx);

		recordMutation(id);
		const check = await run({ command: "echo built > built.txt && true", verify: true });
		expect(check.structuredContent.verification).toMatchObject({ state: "finished", stale: false });
		const checked = currentMutationRevision(id);
		expect(check.structuredContent.verification.revisionAtLaunch).toBe(checked);

		await run({ command: "ls" });
		expect(currentMutationRevision(id)).toBe(checked);
		await run({ command: "echo changed > other.txt" });
		expect(currentMutationRevision(id)).toBe(checked + 1);
		const again = await run({ command: "true", verify: true });
		expect(again.structuredContent.verification).toMatchObject({ stale: false, revisionAtLaunch: checked + 1 });
	});
});
