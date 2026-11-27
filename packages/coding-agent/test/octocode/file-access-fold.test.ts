import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTEXT_FILE_CANDIDATES } from "../../src/core/discovery/sources.ts";
import {
	RUNS_LATER_ANYWHERE,
	RUNS_LATER_AT_ROOT,
	runsLater,
	stateFolderRefusal,
} from "../../src/octocode/permission/file-access.ts";
import { foldName } from "../../src/octocode/permission/fold-name.ts";
import {
	agentStateEntry,
	LOADED_BY_LATER_SESSIONS,
	loadedFromAgentDir,
} from "../../src/octocode/permission/later-session-loaded.ts";
import { memoryFileRefusal } from "../../src/octocode/permission/memory-files.ts";
import { literalPolicy } from "../../src/octocode/permission/sandbox/linux-paths.ts";
import { sandboxPolicy } from "../../src/octocode/permission/sandbox/policy.ts";
import { protectedPaths, readOnlyProtectedPaths } from "../../src/octocode/permission/sandbox/protected.ts";
import { mainEnv } from "./sandbox-helpers.ts";
import { AGENT_DIR, AGENT_FOLDERS, MEMORY_FILE, OCTOCODE_DIR } from "../../src/storage/agent-layout.ts";
import { tmp } from "./helpers.ts";

/** `name` spelled the way a case-insensitive file system still opens as `name`: upper-cased, `ss` as `ß`, `s` as `ſ`, `k` as the Kelvin sign. */
const respelled = (name: string): string =>
	name.toUpperCase().replaceAll("SS", "\u00df").replaceAll("S", "\u017f").replaceAll("K", "\u212a");

describe("foldName", () => {
	it("folds what APFS, NTFS and HFS+ open as one name", () => {
		expect(foldName("\u017fettings.json")).toBe("settings.json");
		expect(foldName("se\u00dfions")).toBe("sessions");
		expect(foldName("SE\u1e9eIONS")).toBe("sessions");
		expect(foldName("\u212aey")).toBe("key");
		expect(foldName("\ufb01le")).toBe("file");
		expect(foldName("cafe\u0301")).toBe(foldName("caf\u00e9"));
		expect(foldName(".mcp\u200d.json")).toBe(".mcp.json");
		expect(foldName(".MCP.JSON")).toBe(".mcp.json");
	});

	it("drops a Windows name's trailing dots and spaces, never a `.` or `..` segment", () => {
		expect(foldName(".mcp.json. ", "win32")).toBe(".mcp.json");
		expect(foldName("a\\.git.\\hooks..\\x", "win32")).toBe("a\\.git\\hooks\\x");
		expect(foldName("../.\\x", "win32")).toBe("../.\\x");
		expect(foldName(".mcp.json.", "darwin")).toBe(".mcp.json.");
	});
});

describe("runsLater, folded", () => {
	const root = "/work";
	const at = (relative: string) => path.join(root, relative);

	it("asks for every spelling of a protected name", () => {
		const names = [
			...RUNS_LATER_AT_ROOT.map((entry) => `${entry}/x`),
			...RUNS_LATER_ANYWHERE,
			...RUNS_LATER_ANYWHERE.map((entry) => `pkg/${entry}`),
			...[...LOADED_BY_LATER_SESSIONS].map((entry) => `${OCTOCODE_DIR}/${entry}`),
			`${AGENT_DIR}/${AGENT_FOLDERS.sessions}/a.jsonl`,
			`${AGENT_DIR}/${MEMORY_FILE}`,
		];
		for (const name of names) {
			expect(runsLater(at(name), root), name).toBe(true);
			expect(runsLater(at(respelled(name)), root), respelled(name)).toBe(true);
		}
	});

	it("asks for instruction files at the root and below it, and for Cursor's project folder", () => {
		for (const file of [
			"AGENTS.md",
			"AGENTS.override.md",
			"CLAUDE.md",
			"agents.md",
			"sub/AGENTS.md",
			"packages/app/CLAUDE.md",
			"a/b/AGENTS.override.md",
			".cursor/mcp.json",
		])
			expect(runsLater(at(file), root), file).toBe(true);
		for (const file of ["docs/AGENTS.md.bak", "AGENTS.md.orig", "my-CLAUDE.md", "docs/agents/guide.md"])
			expect(runsLater(at(file), root), file).toBe(false);
	});
});

describe("stateFolderRefusal, folded", () => {
	it("refuses every spelling of a workspace's state entries", () => {
		const root = fs.realpathSync(tmp());
		for (const entry of [AGENT_FOLDERS.sessions, AGENT_FOLDERS.sessionData, AGENT_FOLDERS.marker, "backlog.md"]) {
			const spelled = path.join(root, AGENT_DIR, respelled(entry), "x");
			expect(stateFolderRefusal(spelled, entry, "file"), spelled).toMatch(/state folder/);
		}
		expect(stateFolderRefusal(path.join(root, AGENT_DIR, respelled("temp/sessions"), "j.json"), "t", "file")).toMatch(
			/state folder/,
		);
	});

	it("still refuses the plain spelling after a folded folder was made on disk", () => {
		const root = fs.realpathSync(tmp());
		fs.mkdirSync(path.join(root, AGENT_DIR, "\u017fessions"), { recursive: true });
		// On a case-insensitive disk `sessions/` now opens `ſessions/`, and the canonical path names the latter.
		expect(stateFolderRefusal(path.join(root, AGENT_DIR, "sessions", "b.jsonl"), "b", "file")).toMatch(/state folder/);
	});
});

/** A sandbox entry made concrete: a `**` or `*` stands for a folder name, `agents.txt*` for its lock file. */
const concrete = (entry: string): string => entry.replaceAll("**", "pkg").replaceAll("*", "w1");

describe("the sandbox's protected list mirrors runsLater", () => {
	const root = "/work";
	const at = (...parts: string[]) => path.join(root, ...parts);

	it("names only paths runsLater asks for or the state refusal refuses", () => {
		for (const entry of [...protectedPaths(root), ...readOnlyProtectedPaths(root)]) {
			const file = concrete(entry);
			const covered = runsLater(file, root) || stateFolderRefusal(file, entry, "file") !== undefined;
			expect(covered, entry).toBe(true);
		}
	});

	it("names every rule runsLater decides by, at the root, in the spelling its loader opens", () => {
		const denied = new Set(protectedPaths(root));
		// The repository's own `.git` stays writable for commits: its hooks and config are what run later.
		const expected = [
			...RUNS_LATER_AT_ROOT.filter((entry) => entry !== ".git").map((entry) => at(entry)),
			at(".git", "hooks"),
			at(".git", "config"),
			at("**", ".git", "hooks"),
			...RUNS_LATER_ANYWHERE.map((entry) => at(entry)),
			...CONTEXT_FILE_CANDIDATES.map((name) => at(name)),
			...[...LOADED_BY_LATER_SESSIONS].map((entry) => at(OCTOCODE_DIR, entry)),
			...[AGENT_FOLDERS.marker, AGENT_FOLDERS.sessions, AGENT_FOLDERS.sessionData, "backlog.md", "backlog.html"]
				.filter((name) => agentStateEntry(name))
				.map((name) => at(AGENT_DIR, name)),
			at(AGENT_DIR, MEMORY_FILE),
			at(AGENT_DIR, AGENT_FOLDERS.worktrees, "*", "AGENTS.md"),
		];
		for (const entry of expected) expect(denied.has(entry), entry).toBe(true);
		expect(readOnlyProtectedPaths(root)).toContain(at(AGENT_DIR, AGENT_FOLDERS.worktrees));
	});
});

describe("what a later session loads from .octocode/, in the spelling its loader opens", () => {
	it("asks for the system prompt files and the project models.json under any case or fold", () => {
		const root = "/work";
		for (const name of [
			"SYSTEM.md",
			"system.md",
			"System.Md",
			"\u017fy\u017ftem.md",
			"APPEND_SYSTEM.md",
			"append_system.md",
			"models.json",
			"MODEL\u017f.JSON",
		])
			expect(runsLater(path.join(root, OCTOCODE_DIR, name), root), name).toBe(true);
		expect(runsLater(path.join(root, OCTOCODE_DIR, "models.json.bak"), root)).toBe(false);
	});

	it("hands the Linux backend those loader spellings as literal denials", () => {
		const root = fs.realpathSync(tmp());
		const policy = sandboxPolicy(root, { setting: "on", mode: "workspace", env: mainEnv() });
		if (!policy) throw new Error("sandbox.mode on must make a policy");
		const denied = literalPolicy(policy).denyWrite;
		for (const name of [
			"SYSTEM.md",
			"APPEND_SYSTEM.md",
			"models.json",
			"AGENTS.md",
			"AGENTS.MD",
			"CLAUDE.md",
			"settings.json",
		])
			expect(denied, name).toContain(path.join(root, OCTOCODE_DIR, name));
	});

	it("folds the agent folder's entries and the curated memory file the same way", () => {
		for (const entry of [
			"\u017fe\u017f\u017fion\u017f",
			"se\u00dfions",
			"SESSION-DATA",
			"Backlog.MD",
			"agents.txt.lock",
		])
			expect(agentStateEntry(entry), entry).toBe(true);
		expect(loadedFromAgentDir("WORKTREE\u017f")).toBe(true);
		expect(loadedFromAgentDir("tmp")).toBe(false);
		const cwd = fs.realpathSync(tmp());
		for (const name of ["MEMORY.md", "memory.MD", "MEMO\u200dRY.md"])
			expect(memoryFileRefusal(path.join(cwd, AGENT_DIR, name), name, "file", cwd), name).toMatch(
				/curated memory file/,
			);
		expect(memoryFileRefusal(path.join(cwd, AGENT_DIR, "MEMORY.md.bak"), "x", "file", cwd)).toBeUndefined();
	});
});
