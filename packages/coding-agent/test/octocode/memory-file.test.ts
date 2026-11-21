import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMemoryOps,
	contextRepeats,
	evictionRank,
	evictToFit,
	type MemoryOp,
	parseMemoryOps,
} from "../../src/octocode/memory/file/consolidate.ts";
import {
	countedLines,
	loadableLines,
	MEMORY_SECTIONS,
	MEMORY_SOURCES,
	type MemoryLine,
	parseMemoryFile,
	serializeMemoryFile,
	validateMemoryLines as validate,
} from "../../src/octocode/memory/file/format.ts";
import { ensureMemoryDir, trackedByGit } from "../../src/octocode/memory/file/paths.ts";
import {
	globalMemoryFile,
	type MemoryFileRef,
	memoryWorkspaceRoot,
	workspaceMemoryFile,
} from "../../src/octocode/permission/memory-files.ts";
import { memorySettings, writesAutomatically, writesExplicit } from "../../src/octocode/memory/file/settings.ts";
import { MemoryFileError, MemoryFileTrackedError, updateMemoryFile } from "../../src/octocode/memory/file/writer.ts";
import { TEST_PROTECTED_HOMES_ENV } from "../../src/storage/state-paths.ts";
import { tmp } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const line = (text: string, extra: Partial<MemoryLine> = {}): MemoryLine => ({
	section: "Decisions",
	pinned: false,
	text,
	source: "agent",
	date: "2026-01-01",
	...extra,
});

beforeEach(() => {
	const home = tmp("memfile-home-");
	vi.stubEnv("OCTOCODE_HOME", path.join(home, ".octocode", "octocodecode"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(home, "agent.db"));
});
afterEach(() => vi.unstubAllEnvs());

describe("MEMORY.md paths", () => {
	it("resolves a linked worktree to the main checkout's file, and a folder outside git to its workspace root", () => {
		const repo = fs.realpathSync(tmp("memfile-repo-"));
		git(repo, "init", "-q");
		git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
		const tree = path.join(fs.realpathSync(tmp("memfile-wt-")), "wt");
		git(repo, "worktree", "add", "-q", tree);
		fs.mkdirSync(path.join(tree, "src"));
		const expected = path.join(repo, ".octocode", "agent", "MEMORY.md");
		expect(workspaceMemoryFile(path.join(tree, "src"))).toEqual({ scope: "workspace", path: expected, root: repo });
		expect(workspaceMemoryFile(repo).path).toBe(expected);
		const plain = fs.realpathSync(tmp("memfile-plain-"));
		expect(memoryWorkspaceRoot(plain)).toBe(plain);
	});

	it("puts the global file in the Octocode home, and refuses the real home's file under a test run", () => {
		const home = tmp("memfile-own-");
		expect(globalMemoryFile({ OCTOCODE_HOME: home }).path).toBe(path.join(home, "MEMORY.md"));
		const real = tmp("memfile-real-");
		const env = { OCTOCODE_HOME: path.join(real, ".octocode", "octocodecode"), [TEST_PROTECTED_HOMES_ENV]: real };
		expect(() => globalMemoryFile(env)).toThrow(/real global memory file/);
	});

	it("creates the file's folder without writing a .gitignore of its own", () => {
		const ref = workspaceMemoryFile(tmp("memfile-ignore-"));
		ensureMemoryDir(ref);
		expect(fs.readdirSync(path.dirname(ref.path))).toEqual([]);
		ensureMemoryDir(globalMemoryFile());
		expect(fs.existsSync(path.join(path.dirname(globalMemoryFile().path), ".gitignore"))).toBe(false);
	});
});

describe("MEMORY.md format", () => {
	it("round-trips sections in their fixed order, pins, sources, dates and notes, and drops empty sections", () => {
		const text = [
			"## Gotchas",
			"- Codex CLI ignores OPENAI_BASE_URL; use a mock provider (agent 2026-11-12, recheck)",
			"## Preferences",
			"- ! Answer research questions in the reply (user 2026-11-17)",
			"- Hand-written line without a trailer",
			"## Pointers",
			"",
		].join("\n");
		const parsed = parseMemoryFile(text);
		expect(parsed.problems).toEqual([]);
		expect(
			parsed.lines.map(({ section, pinned, source, date, note }) => [section, pinned, source, date, note]),
		).toEqual([
			["Gotchas", false, "agent", "2026-11-12", "recheck"],
			["Preferences", true, "user", "2026-11-17", undefined],
			["Preferences", false, "user", undefined, undefined],
		]);
		const out = serializeMemoryFile(parsed.lines);
		expect(out).toBe(
			[
				"## Preferences",
				"- ! Answer research questions in the reply (user 2026-11-17)",
				"- Hand-written line without a trailer",
				"## Gotchas",
				"- Codex CLI ignores OPENAI_BASE_URL; use a mock provider (agent 2026-11-12, recheck)",
				"",
			].join("\n"),
		);
		expect(serializeMemoryFile(parseMemoryFile(out).lines)).toBe(out);
		expect(countedLines(parsed.lines)).toBe(5);
		expect(parseMemoryFile("## Notes\n- x\nfree text").problems.map((problem) => problem.reason)).toEqual([
			expect.stringContaining("unknown section"),
			"not a `- ` line",
		]);
	});

	it("caps the global file at 30 lines and the workspace file at 40, a setting may only lower either", () => {
		const global = { scope: "global" } as const;
		const workspace = { scope: "workspace" } as const;
		const fits = (count: number) => Array.from({ length: count }, (_, i) => line(`Decision number ${i}`));
		expect(validate(fits(29), global)).toEqual([]);
		expect(validate(fits(30), global)[0]).toMatch(/31 lines with headings, over the cap of 30/);
		expect(validate(fits(39), workspace)).toEqual([]);
		expect(validate(fits(40), workspace)[0]).toMatch(/41 lines with headings, over the cap of 40/);
		expect(validate(fits(29), { ...global, maxLines: 40 })).toEqual([]);
		expect(validate(fits(30), { ...global, maxLines: 40 })[0]).toMatch(/over the cap of 30/);
		expect(validate(fits(39), { ...workspace, maxLines: 100 })).toEqual([]);
		expect(validate(fits(29), { ...workspace, maxLines: 10 })[0]).toMatch(/over the cap of 10/);
		expect(countedLines(loadableLines(fits(60), "global").lines)).toBe(30);
		expect(countedLines(loadableLines(fits(60), "workspace").lines)).toBe(40);
	});

	it("refuses a long line, a secret and a duplicate, and keeps pins byte-identical", () => {
		const validateMemoryLines = (
			lines: readonly MemoryLine[],
			options: Omit<Parameters<typeof validate>[1], "scope"> = {},
		) => validate(lines, { scope: "global", ...options });
		expect(validateMemoryLines([line("x".repeat(190))])[0]).toMatch(/over 200/);
		expect(validateMemoryLines([line("Deploy key AKIAABCDEFGHIJKLMNOP for staging")])[0]).toMatch(/secret/);
		expect(validateMemoryLines([line("Use yarn"), line("use YARN.")])[0]).toMatch(/repeats another line/);
		const pin = line("Never push to main", { pinned: true, source: "user" });
		expect(validateMemoryLines([{ ...pin, date: "2026-02-02" }], { previous: [pin] })[0]).toMatch(/pinned line/);
		expect(validateMemoryLines([], { previous: [pin], allowPinChanges: true })).toEqual([]);
	});

	it("skips a secret on load and cuts at the cap", () => {
		const lines = [line("Rotate with token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"), line("Keep this one")];
		const loaded = loadableLines(lines, "global");
		expect(loaded.lines.map((kept) => kept.text)).toEqual(["Keep this one"]);
		expect(loaded.skipped[0].reason).toMatch(/secret/);
		const many = loadableLines(
			Array.from({ length: 40 }, (_, i) => line(`Fact ${i}`)),
			"global",
		);
		expect(countedLines(many.lines)).toBe(30);
		expect(many.skipped).toHaveLength(11);
	});
});

describe("memory ops", () => {
	it("validates op lists before anything is applied", () => {
		const ops = [{ op: "add", section: "Gotchas", text: "Bump retires the DB", source: "reflection" }];
		expect(parseMemoryOps(ops)).toEqual(ops);
		// The schema takes every section and source the format has.
		const every = MEMORY_SECTIONS.flatMap((section) =>
			MEMORY_SOURCES.map((source) => ({ op: "add", section, text: `${section} by ${source}`, source })),
		);
		expect(parseMemoryOps(every)).toHaveLength(MEMORY_SECTIONS.length * MEMORY_SOURCES.length);
		expect(() => parseMemoryOps([{ op: "add", section: "Notes", text: "x" }])).toThrow(/Invalid memory ops/);
		expect(() => parseMemoryOps([{ op: "merge", targets: ["one"], text: "x" }])).toThrow(/Invalid memory ops/);
		expect(() => parseMemoryOps([{ op: "rewrite", target: "a", text: "b", extra: 1 }])).toThrow(/Invalid memory ops/);
	});

	it("applies add, merge, rewrite, evict and flag, and applying the same ops again changes nothing", () => {
		const start = [line("Use yarn, not npm"), line("Prefer tabs"), line("Prefer tab indentation"), line("Old pointer")];
		const ops: MemoryOp[] = [
			{ op: "add", section: "Gotchas", text: "A schema bump retires the DB" },
			{
				op: "merge",
				targets: ["Prefer tabs", "prefer TAB indentation"],
				text: "Indent with tabs",
				section: "Preferences",
			},
			{ op: "rewrite", target: "- Use yarn, not npm (agent 2026-01-01)", text: "Use yarn; npm breaks the lockfile" },
			{ op: "evict", target: "old pointer" },
			{ op: "flag", target: "A schema bump retires the DB", reason: "check db.ts" },
		];
		const once = applyMemoryOps(start, ops, { date: "2026-11-19" });
		expect(once.lines.map((kept) => [kept.section, kept.text, kept.date])).toEqual([
			["Decisions", "Use yarn; npm breaks the lockfile", "2026-11-19"],
			["Preferences", "Indent with tabs", "2026-01-01"],
			["Gotchas", "A schema bump retires the DB", "2026-11-19"],
		]);
		expect(once.evicted.map((gone) => gone.text)).toEqual(["Old pointer"]);
		expect(once.flagged).toEqual([
			{ line: expect.objectContaining({ text: "A schema bump retires the DB" }), reason: "check db.ts" },
		]);
		const twice = applyMemoryOps(once.lines, ops, { date: "2026-11-19" });
		expect(twice.lines).toEqual(once.lines);
		expect(twice.skipped.map((skip) => skip.reason)).toEqual([
			"already applied",
			"already applied",
			"no line matches the target",
		]);
	});

	it("never changes a pinned line without approval, and a re-added fact confirms its date and keeps the higher source", () => {
		const pin = line("Never push to main", { pinned: true, source: "user" });
		const ops: MemoryOp[] = [
			{ op: "rewrite", target: "Never push to main", text: "Push to main sometimes" },
			{ op: "evict", target: "Never push to main" },
			{ op: "add", section: "Decisions", text: "Never push to main", source: "agent" },
		];
		const locked = applyMemoryOps([pin], ops, { date: "2026-11-19" });
		expect(locked.lines).toEqual([pin]);
		expect(locked.skipped.map((skip) => skip.reason)).toEqual([
			"a target line is pinned",
			"the line is pinned",
			"already pinned",
		]);
		const confirmed = applyMemoryOps(
			[line("Prefer tabs", { source: "user" })],
			[{ op: "add", section: "Preferences", text: "prefer tabs" }],
			{
				date: "2026-11-19",
			},
		);
		expect(confirmed.lines).toEqual([line("Prefer tabs", { source: "user", date: "2026-11-19" })]);
	});

	it("evicts by source, then kind, then date, never a pinned line", () => {
		const lines = [
			line("Pinned agent pointer", { section: "Pointers", pinned: true }),
			line("User pointer", { section: "Pointers", source: "user" }),
			line("Agent decision, new", { date: "2026-11-01" }),
			line("Agent decision, old", { date: "2026-01-01" }),
			line("Agent pointer", { section: "Pointers", date: "2026-11-18" }),
			line("Reflection gotcha", { section: "Gotchas", source: "reflection" }),
		];
		expect(evictionRank(lines[1])).toEqual([3, 1, "2026-01-01"]);
		const order: string[] = [];
		for (let cap = countedLines(lines) - 1; cap >= 1; cap--) {
			const fit = evictToFit(lines, "global", cap);
			for (const gone of fit.evicted) if (!order.includes(gone.text)) order.push(gone.text);
		}
		expect(order).toEqual([
			"Agent pointer",
			"Agent decision, old",
			"Agent decision, new",
			"Reflection gotcha",
			"User pointer",
		]);
		expect(evictToFit(lines, "global", 1).lines.map((kept) => kept.text)).toEqual(["Pinned agent pointer"]);
	});

	it("drops an add or rewrite that repeats AGENTS.md or shipped policy", () => {
		const repeats = contextRepeats([
			{
				name: "AGENTS.md",
				text: "# Rules\n- Files stay within 400 lines (tests exempt): split by concern, never add an exception.",
			},
		]);
		expect(repeats("Source files stay within 400 lines; split by concern")).toMatch(
			/^AGENTS\.md: "Files stay within 400 lines/,
		);
		expect(repeats("The DB writer worker runs on plain Node")).toBeUndefined();
		const applied = applyMemoryOps(
			[],
			[{ op: "add", section: "Decisions", text: "Files stay within 400 lines, split by concern" }],
			{
				date: "2026-11-19",
				repeats,
			},
		);
		expect(applied.lines).toEqual([]);
		expect(applied.skipped[0].reason).toMatch(/^repeats AGENTS\.md/);
	});
});

describe("MEMORY.md writer", () => {
	const fileIn = (root: string): MemoryFileRef => workspaceMemoryFile(root);
	const fill = (ref: MemoryFileRef, count: number, extra: Partial<MemoryLine> = {}) => {
		ensureMemoryDir(ref);
		const lines = Array.from({ length: count }, (_, i) =>
			line(`Old decision ${String(i).padStart(2, "0")}`, {
				date: `2026-03-${String(i + 1).padStart(2, "0")}`,
				...extra,
			}),
		);
		fs.writeFileSync(ref.path, serializeMemoryFile(lines));
	};
	const add = (text: string): Extract<MemoryOp, { op: "add" }> => ({ op: "add", section: "Decisions", text });

	it("hands the lines it evicts to beforeWrite first, and leaves the file whole when beforeWrite fails", async () => {
		const ref = fileIn(tmp("memfile-archive-first-"));
		fill(ref, 39);
		const before = fs.readFileSync(ref.path, "utf8");
		const seen: string[] = [];
		await expect(
			updateMemoryFile(ref, [add("A decision that evicts")], {
				beforeWrite: async (planned) => {
					seen.push(...planned.evicted.map((gone) => gone.text));
					throw new Error("database is locked");
				},
			}),
		).rejects.toThrow("database is locked");
		expect(seen).toEqual(["Old decision 00"]);
		// The evicted line is still in the file, since it never reached the archive.
		expect(fs.readFileSync(ref.path, "utf8")).toBe(before);
	});

	it("takes a 41st line by evicting the weakest unpinned line, and refuses it when every line is pinned", async () => {
		const ref = fileIn(tmp("memfile-cap-"));
		fill(ref, 39);
		const update = await updateMemoryFile(ref, [add("A brand new decision")], { now: new Date(2026, 10, 19) });
		expect(update.evicted.map((gone) => gone.text)).toEqual(["Old decision 00"]);
		const text = fs.readFileSync(ref.path, "utf8");
		expect(text.split("\n").filter(Boolean)).toHaveLength(40);
		expect(text).toContain("- A brand new decision (agent 2026-11-19)");
		const pinned = fileIn(tmp("memfile-pinned-"));
		fill(pinned, 39, { pinned: true, source: "user" });
		const before = fs.readFileSync(pinned.path, "utf8");
		// Every other line is pinned: the new line is the weakest, so it is the one left out.
		const refused = await updateMemoryFile(pinned, [add("No room for this")]);
		expect([refused.changed, refused.evicted.map((gone) => gone.text)]).toEqual([false, ["No room for this"]]);
		// A pinned 41st line has nothing to displace: the validator refuses the file.
		await expect(
			updateMemoryFile(pinned, [{ ...add("Pinned with no room"), pinned: true }], { allowPinChanges: true }),
		).rejects.toThrow(/41 lines with headings, over the cap of 40/);
		expect(fs.readFileSync(pinned.path, "utf8")).toBe(before);
	});

	it("lands two concurrent writers and stays within 40 lines", async () => {
		const ref = fileIn(tmp("memfile-race-"));
		fill(ref, 38);
		await Promise.all([
			updateMemoryFile(ref, [add("Writer A's decision")]),
			updateMemoryFile(ref, [add("Writer B's decision")]),
		]);
		const lines = parseMemoryFile(fs.readFileSync(ref.path, "utf8")).lines.map((kept) => kept.text);
		expect(lines).toEqual(expect.arrayContaining(["Writer A's decision", "Writer B's decision"]));
		expect(lines.length + 1).toBeLessThanOrEqual(40);
		// Nothing is left behind next to the file: no temp files and no lock.
		expect(fs.readdirSync(path.dirname(ref.path)).sort()).toEqual(["MEMORY.md"]);
	});

	it("refuses a git-tracked file and proposes the change as a diff", async () => {
		const repo = fs.realpathSync(tmp("memfile-tracked-"));
		git(repo, "init", "-q");
		const ref = fileIn(repo);
		fill(ref, 1);
		fs.writeFileSync(path.join(path.dirname(ref.path), ".gitignore"), "");
		git(repo, "add", "-f", ref.path);
		expect(trackedByGit(ref)).toBe(true);
		const before = fs.readFileSync(ref.path, "utf8");
		const error = await updateMemoryFile(ref, [add("Proposed decision")]).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(MemoryFileTrackedError);
		expect((error as MemoryFileTrackedError).diff).toContain("+- Proposed decision (agent ");
		expect(fs.readFileSync(ref.path, "utf8")).toBe(before);
		expect(trackedByGit(fileIn(fs.realpathSync(tmp("memfile-untracked-"))))).toBe(false);
	});

	it("refuses a file with content it cannot place, and writes nothing on a dry run", async () => {
		const ref = fileIn(tmp("memfile-stray-"));
		ensureMemoryDir(ref);
		fs.writeFileSync(ref.path, "# My notes\n## Decisions\n- Keep\n");
		await expect(updateMemoryFile(ref, [add("Another")])).rejects.toThrow(MemoryFileError);
		const fresh = fileIn(tmp("memfile-dry-"));
		const planned = await updateMemoryFile(fresh, [add("Planned only")], { dryRun: true });
		expect(planned.changed).toBe(true);
		expect(planned.diff).toContain("+- Planned only");
		expect(fs.existsSync(fresh.path)).toBe(false);
	});

	it("refuses to write a workspace file inside the real home during a test run", async () => {
		const home = fs.realpathSync(tmp("memfile-realhome-"));
		const ref = fileIn(path.join(home, "code"));
		fs.mkdirSync(path.join(home, "code"));
		await expect(
			updateMemoryFile(ref, [add("Never written")], {}, { ...process.env, [TEST_PROTECTED_HOMES_ENV]: home }),
		).rejects.toThrow(/inside the real home/);
		expect(fs.existsSync(ref.path)).toBe(false);
	});
});

describe("memory settings", () => {
	it("fills defaults and says who may write", () => {
		const defaults = memorySettings(undefined);
		expect(defaults).toEqual({
			file: true,
			autoUpdate: "auto",
			subagents: "workspace",
			recall: "main",
			reflection: true,
			subagentPinnedKind: "preference",
		});
		expect([writesExplicit(defaults), writesAutomatically(defaults)]).toEqual([true, true]);
		const explicit = memorySettings({ memory: { autoUpdate: "explicit" } });
		expect([writesExplicit(explicit), writesAutomatically(explicit)]).toEqual([true, false]);
		expect(writesExplicit(memorySettings({ memory: { file: false } }))).toBe(false);
	});
});
