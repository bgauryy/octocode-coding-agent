import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { ensureMemoryDir } from "../../src/octocode/memory/file/paths.ts";
import { MEMORY_SECTION, registerMemorySection } from "../../src/octocode/memory/file/section.ts";
import { MemoryError, memoryStore } from "../../src/octocode/memory/store.ts";
import { workspaceMemoryFile } from "../../src/octocode/permission/memory-files.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const run = (cwd: string, command: string) => execSync(command, { cwd, stdio: "pipe" }).toString().trim();
let root: string;

beforeEach(() => {
	root = fs.realpathSync(tmp("memtrust-"));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	vi.stubEnv("OCTOCODE_MEMORY_AUTO", "");
});
afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
});

describe("the main checkout's MEMORY.md reaches a linked worktree only from a trusted folder", () => {
	it("skips it, with a notice, until the main checkout is trusted", async () => {
		const main = path.join(root, "main");
		fs.mkdirSync(main);
		run(main, "git init -q -b main");
		run(main, "git -c user.email=t@e.x -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init");
		const worktree = path.join(root, "feature");
		run(main, `git worktree add -q -b feature ${worktree}`);
		const ref = workspaceMemoryFile(worktree);
		expect(ref.root).toBe(main);
		ensureMemoryDir(ref);
		fs.writeFileSync(ref.path, "## Decisions\n- Shared note (user 2026-11-18)\n");

		const section = async (cwd: string) => {
			const fake = fakeHost();
			registerMemorySection(fake.api, { isSubagent: false });
			const event = { systemPromptOptions: { sections: {} as Record<string, string>, contextFiles: [] }, prompt: "x" };
			const ctx = fakeCtx({ cwd, hasUI: true });
			await fake.fire("before_agent_start", event, ctx);
			return { text: event.systemPromptOptions.sections[MEMORY_SECTION] ?? "", notes: ctx.ui.notes };
		};
		const own = await section(main);
		expect(own.text).toContain("Shared note");
		const linked = await section(worktree);
		expect(linked.text).not.toContain("Shared note");
		expect(JSON.stringify(linked.notes)).toContain("not trusted");
	});
});

describe("a rename inside one scope", () => {
	it("is refused when it repeats another memory, and a plain edit of a memory is not", () => {
		const cwd = path.join(root, "repo");
		fs.mkdirSync(cwd);
		const store = memoryStore(cwd);
		const author = "agent";
		const a = store.set({ title: "Deploy uses blue green rollout", body: "Roll out blue then green.", author }).memory;
		const b = store.set({ title: "Parser caches tokens", body: "Tokens are cached per file.", author }).memory;
		expect(() => store.set({ id: b.id, title: "Deploy uses blue green rollout", author })).toThrow(MemoryError);
		expect(store.get(b.id)?.title).toBe("Parser caches tokens");
		expect(store.set({ id: a.id, pinned: true, author }).memory.pinned).toBe(true);
		expect(store.set({ id: a.id, title: "Deploy uses blue green rollouts", author }).memory.title).toContain(
			"rollouts",
		);
	});
});
