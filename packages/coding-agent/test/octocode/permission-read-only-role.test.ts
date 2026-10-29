import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCallEvent } from "../../src/core/extensions/index.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { PERMISSION_ENV, READ_ONLY_ENV, SUBAGENT_ENV, AGENT_SCRATCH_ENV } from "../../src/octocode/shared/env.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * A read-only child (`readOnly: true` profile) is refused changes by the permission gate in every mode: the real `file`
 * tool and a real shell run only when the gate lets the call through, and the repository is checked afterwards.
 */
function child(mode: "full" | "workspace", readOnly = true) {
	const cwd = fs.realpathSync(tmp());
	execSync("git init -q", { cwd });
	fs.mkdirSync(path.join(cwd, "src"));
	fs.writeFileSync(path.join(cwd, "src/a.ts"), "original");
	const scratch = path.join(cwd, ".octocode/tmp/agents/rev-1");
	fs.mkdirSync(scratch, { recursive: true });
	const env = {
		[SUBAGENT_ENV]: "1",
		...(readOnly ? { [READ_ONLY_ENV]: "1" } : {}),
		[AGENT_SCRATCH_ENV]: scratch,
		[PERMISSION_ENV]: mode,
	};
	const fake = fakeHost();
	const ctx = fakeCtx({ cwd, hasUI: false });
	const permission = new Permission({ api: fake.api, env, isSubagent: true });
	permission.start(ctx);
	registerFileTool(fake.api, new FileGuard(), permission, undefined, { enabled: () => true, refresh: async () => {} });
	const gate = permissionGate({
		permission,
		provenance: { check: () => undefined },
		env,
	});
	let id = 0;
	/** Runs the gate and, when it allows, the call for real. */
	const attempt = async (toolName: string, input: Record<string, unknown>) => {
		const event = { type: "tool_call", toolCallId: `t${++id}`, toolName, input } as ToolCallEvent;
		const verdict = await gate(event, ctx);
		if (verdict?.block) return verdict.reason ?? "blocked";
		// Workspace mode asks before any change under `.octocode/` and no one can answer here: only its gate verdict is checked.
		if (mode === "workspace") return undefined;
		if (toolName === "file") await fake.tools.get("file")!.execute(event.toolCallId, input, undefined, undefined, ctx);
		else execSync(String(input.command), { cwd, stdio: "ignore" });
		return undefined;
	};
	const read = (file: string) =>
		fs.existsSync(path.join(cwd, file)) ? fs.readFileSync(path.join(cwd, file), "utf8") : undefined;
	return { cwd, scratch, attempt, read };
}

const write = (file: string, content = "changed") => ({
	queries: [{ type: "write", path: file, content, reason: "test" }],
});

describe.each((["full", "workspace"] as const).map((mode) => [mode]))("read-only subagent role in %s mode", (mode) => {
	it("refuses `file` writes outside scratch and docs, and allows scratch and `.octocode` docs", async () => {
		const { attempt, read, scratch, cwd } = child(mode);
		expect(await attempt("file", write("src/a.ts"))).toMatch(/read-only role/);
		expect(await attempt("file", write("src/new.ts"))).toMatch(/read-only role/);
		expect(await attempt("file", write(path.join(cwd, ".octocode/skills/x/SKILL.md")))).toMatch(/read-only role/);
		expect(await attempt("file", write(".octocode/hooks.json", "{}"))).toMatch(/read-only role/);
		expect(await attempt("file", { patch: "*** Begin Patch\n*** Add File: src/p.ts\n+x\n*** End Patch" })).toMatch(
			/read-only role/,
		);
		expect(read("src/a.ts")).toBe("original");
		expect(read("src/new.ts")).toBeUndefined();
		expect(read("src/p.ts")).toBeUndefined();

		expect(await attempt("file", write(path.join(scratch, "report.md"), "findings"))).toBeUndefined();
		expect(await attempt("file", write(".octocode/review/notes.md", "notes"))).toBeUndefined();
		// A skill's run folder under `.octocode/<skill>/tmp/` is scratch: ledgers and probes there are not docs.
		expect(
			await attempt("file", write(".octocode/octocode-brainstorming/tmp/run-1/ledger-A.jsonl", "{}")),
		).toBeUndefined();
		expect(await attempt("file", write(".octocode/review/data.json", "{}"))).toMatch(/read-only role/);
		expect(await attempt("file", write(".octocode/skills/tmp/x.json", "{}"))).toMatch(/read-only role/);
		if (mode === "full") {
			expect(fs.readFileSync(path.join(scratch, "report.md"), "utf8")).toBe("findings");
			expect(read(".octocode/review/notes.md")).toBe("notes");
		}
	});

	it("refuses Markdown in folders a later session loads as profiles, prompts or settings, in any letter case", async () => {
		const { attempt, read } = child(mode);
		for (const file of [
			".octocode/agents/evil.md",
			".octocode/Agents/evil.md",
			".octocode/agents/tmp/evil.md",
			".octocode/prompts/p.md",
			".octocode/themes/t.md",
			".octocode/extensions/e.md",
			".octocode/SYSTEM.md",
			".octocode/APPEND_SYSTEM.md",
			".octocode/settings.json",
			".octocode/skills/x/SKILL.md",
		])
			expect(await attempt("file", write(file)), file).toMatch(/read-only role/);
		expect(await attempt("bash", { command: "echo x > .octocode/agents/evil.md" })).toMatch(/read-only role/);
		expect(read(".octocode/agents/evil.md")).toBeUndefined();
		expect(await attempt("file", write(".octocode/review/notes.md"))).toBeUndefined();
		expect(await attempt("file", write(".octocode/tmp/agents/x/report.md"))).toBeUndefined();
		expect(await attempt("file", write(".octocode/topic/tmp/run/ledger.jsonl", "{}"))).toBeUndefined();
	});

	it("resolves `..` after a symlink for shell writes: a link outside the workspace can lead back into it", async () => {
		const { attempt, cwd, read } = child(mode);
		const outside = fs.realpathSync(tmp());
		fs.symlinkSync(path.join(cwd, "src"), path.join(outside, "lnk"));
		// Lexically `<outside>/y.ts`; for the shell `<outside>/lnk/..` is the workspace root.
		expect(await attempt("bash", { command: `echo x > ${outside}/lnk/../y.ts` })).toMatch(/read-only role/);
		expect(read("y.ts")).toBeUndefined();
		// The other direction: a link inside the workspace that leads out is outside, so the write is not the role's concern.
		fs.mkdirSync(path.join(outside, "inner"));
		fs.symlinkSync(path.join(outside, "inner"), path.join(cwd, "rel"));
		expect(await attempt("bash", { command: "echo x > rel/../z.ts" })).toBeUndefined();
	});

	it("allows `graphBuild`, which writes only derived snapshots under `.octocode/graph/`", async () => {
		const { cwd } = child(mode);
		const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
		const event = { toolName: "graphBuild", input: { request: { queries: [{ path: "." }] } } };
		expect(readOnlyRoleRefusal(event, cwd, env)).toBeUndefined();
		expect(readOnlyRoleRefusal({ toolName: "debug", input: { action: "launch" } }, cwd, env)).toMatch(/read-only role/);
	});

	it("refuses mutating bash commands and allows scratch writes and reads", async () => {
		const { attempt, read, scratch } = child(mode);
		for (const command of [
			"echo changed > src/a.ts",
			"echo changed | tee src/a.ts",
			"sed -i s/original/changed/ src/a.ts",
			"rm src/a.ts",
			"cp src/a.ts src/b.ts",
			"mv src/a.ts src/b.ts",
			"touch src/c.ts",
			"sh -c 'echo changed > src/a.ts'",
			"git checkout -- src",
			"echo changed > $TARGET",
			"env rm src/a.ts",
			"env FOO=1 tee src/a.ts",
			"sudo -u root rm src/a.ts",
			"exec rm src/a.ts",
			"nohup nice -n 5 rm src/a.ts",
			"sudo env time rm src/a.ts",
			"git -C . checkout -- src",
			"git -c user.name=x commit -m x",
		])
			expect(await attempt("bash", { command }), command).toMatch(/read-only role/);
		expect(read("src/a.ts")).toBe("original");
		expect(read("src/b.ts")).toBeUndefined();
		expect(read("src/c.ts")).toBeUndefined();

		expect(await attempt("bash", { command: "ls src | wc -l" })).toBeUndefined();
		expect(await attempt("bash", { command: "git status --short" })).toBeUndefined();
		expect(await attempt("bash", { command: `echo evidence > ${scratch}/e.txt` })).toBeUndefined();
		expect(await attempt("bash", { command: `cp src/a.ts ${scratch}/copy.ts` })).toBeUndefined();
		if (mode === "full") {
			expect(fs.readFileSync(path.join(scratch, "e.txt"), "utf8")).toBe("evidence\n");
			expect(fs.readFileSync(path.join(scratch, "copy.ts"), "utf8")).toBe("original");
		}
	});

	it("does not restrict a child whose profile is not read-only", async () => {
		const { attempt, read } = child(mode, false);
		expect(await attempt("file", write("src/new.ts"))).toBeUndefined();
		expect(await attempt("bash", { command: "echo more > src/b.ts" })).toBeUndefined();
		if (mode === "full") {
			expect(read("src/new.ts")).toBe("changed");
			expect(read("src/b.ts")).toBe("more\n");
		}
	});
});
