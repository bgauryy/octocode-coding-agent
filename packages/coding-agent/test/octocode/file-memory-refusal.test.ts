import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	globalMemoryFile,
	memoryFileRefusal,
	workspaceMemoryFile,
} from "../../src/octocode/permission/memory-files.ts";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** The curated MEMORY.md files belong to the `memory` tool: `file` refuses every change to them, in every mode. */

let repo: string;
beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", path.join(tmp("memhome-"), "home"));
	vi.stubEnv("OCTOCODE_SUBAGENT", "");
	repo = fs.realpathSync(tmp("memrepo-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
	git("init", "-q");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
});
afterEach(() => vi.unstubAllEnvs());

function fileTool(cwd: string) {
	const guard = new FileGuard();
	const host = fakeHost();
	registerFileTool(host.api, guard, fakePermission(), undefined);
	const tool = host.tools.get("file")!;
	const ctx = fakeCtx({ cwd });
	return {
		guard,
		run: (params: Record<string, unknown>) =>
			tool.execute("call", { reason: "test", ...params }, undefined, undefined, ctx),
	};
}

describe("file and the MEMORY.md files", () => {
	it("refuses a write to the repository's MEMORY.md, naming the memory tool, and creates nothing", async () => {
		const target = workspaceMemoryFile(repo).path;
		const { run } = fileTool(repo);
		await expect(
			run({ queries: [{ type: "write", path: target, content: "## Decisions\n- planted\n" }] }),
		).rejects.toThrow(/curated memory file.*`memory` tool/);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("refuses an edit and a delete of an existing file it has read, and leaves it alone", async () => {
		const target = workspaceMemoryFile(repo).path;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "## Decisions\n- keep this\n");
		const { guard, run } = fileTool(repo);
		guard.record(target);
		await expect(
			run({ queries: [{ type: "edit", path: target, edits: [{ oldText: "keep", newText: "drop" }] }] }),
		).rejects.toThrow(/`memory` tool/);
		await expect(run({ queries: [{ type: "delete", path: target }] })).rejects.toThrow(/`memory` tool/);
		expect(fs.readFileSync(target, "utf8")).toBe("## Decisions\n- keep this\n");
	});

	it("refuses the global file with the memory refusal, not only the state-folder one", async () => {
		const target = globalMemoryFile().path;
		const { run } = fileTool(repo);
		await expect(run({ queries: [{ type: "write", path: target, content: "x\n" }] })).rejects.toThrow(
			/curated memory file.*`memory` tool/,
		);
		expect(fs.existsSync(target)).toBe(false);
	});

	it("refuses a patch that adds the file, spelled in another case", async () => {
		const { run } = fileTool(repo);
		const patch = [
			"*** Begin Patch",
			"*** Add File: .octocode/OctocodeCode/memory.md",
			"+- planted",
			"*** End Patch",
		].join("\n");
		await expect(run({ patch })).rejects.toThrow(/curated memory file/);
		expect(fs.existsSync(path.join(repo, ".octocode", "OctocodeCode", "memory.md"))).toBe(false);
	});

	it("refuses the main checkout's file from a linked worktree, and that worktree's own copy", async () => {
		const worktree = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
		execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", worktree], { stdio: "pipe" });
		const cwd = fs.realpathSync(worktree);
		expect(workspaceMemoryFile(cwd).path).toBe(workspaceMemoryFile(repo).path);
		expect(memoryFileRefusal(workspaceMemoryFile(repo).path, "MEMORY.md", "the file tool", cwd)).toMatch(
			/`memory` tool/,
		);
		const { run } = fileTool(cwd);
		await expect(
			run({ queries: [{ type: "write", path: ".octocode/octocodecode/MEMORY.md", content: "x\n" }] }),
		).rejects.toThrow(/curated memory file/);
	});

	it("leaves other files named MEMORY.md alone", async () => {
		const target = path.join(repo, "docs", "MEMORY.md");
		fs.mkdirSync(path.dirname(target));
		expect(memoryFileRefusal(target, "docs/MEMORY.md", "the file tool", repo)).toBeUndefined();
		const { run } = fileTool(repo);
		const result = await run({ queries: [{ type: "write", path: target, content: "# Notes\n" }] });
		expect(result.details.outcomes[0]).toMatchObject({ ok: true });
		expect(fs.readFileSync(target, "utf8")).toBe("# Notes\n");
	});

	it("tells a subagent to report the note instead, since its memory is read-only", () => {
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		expect(memoryFileRefusal(workspaceMemoryFile(repo).path, "MEMORY.md", "Bash", repo)).toMatch(/`Noticed:`/);
	});
});
