import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeReadTool, createReadHint, READ_HINT_LIMIT } from "../../src/octocode/files/read-hint.ts";
import { publishRoles, RESEARCH, RESEARCH_ENTRY } from "./fake-research-roles.ts";

const cwd = "/work/repo";

describe("codeReadTool", () => {
	it.each([
		["rg foo src", "search"],
		["grep -n 'a|b' src/a.ts", "search"],
		["find src -name a.ts", "search"],
		["ls src", "search"],
		["cat src/a.ts", "reader"],
		["head -n 5 src/a.ts", "reader"],
		["tail -n +5 src/a.ts", "reader"],
		["sed -n '1,20p' src/a.ts", "reader"],
		["cd packages/a && rg foo", "search"],
		["set -o pipefail; rg foo src", "search"],
		["cat a.ts; cat b.ts", "reader"],
		[`cat ${cwd}/a.ts`, "reader"],
		["rg foo src | wc -l", "search"],
		["cat src/*.ts", "reader"],
		["git status && cat a.ts", "reader"],
		["rg foo\nrg bar", "search"],
		["cat a.ts || echo none", "reader"],
		// Commands agents wrote in the 2026-11-04 eval, shortened.
		["cd packages/a && wc -l m.ts p.ts && cat -n m.ts", "reader"],
		[
			`cd packages/a && cat -n m.ts | sed -n 80,121p; echo ----; grep -rn "A\\|B(" /dev/null . ../ 2>/dev/null | grep -v "^./m" | head -20`,
			"reader",
		],
		[
			`git diff; cd packages/a; cat -n b.ts | head -120; grep -rn "A\\|b" src ../../C.md | grep -v "^s" | head -60`,
			"reader",
		],
		[
			"cd packages/a; sed -n 18,40p b.ts; grep -n envInt -A12 ../c/e.ts | head -30; ls node_modules 2>&1 | head -2",
			"reader",
		],
		["grep -rn foo src --include=*.ts", "search"],
		["cd src && ls -la | head -30", "search"],
		["cd .octocode/tmp && cat ../../src/a.ts", "reader"],
	])("%s reads with %s", (command, tool) => {
		expect(codeReadTool(command, cwd)).toBe(tool);
	});

	it.each([
		"cat a.ts > b.ts",
		"cat a.ts >> b.ts",
		"for f in a b; do cat $f; done",
		"cat $(git ls-files)",
		"cat `git ls-files`",
		'cat "$FILE"',
		"(cat a.ts)",
		"cat a.ts &",
		"cat ~/a.ts",
		"sed -i 's/a/b/' a.ts",
		"cat a.ts | sed 's/a/b/'",
		"cat a.ts | sort -o a.ts",
		"cat a.ts | tee b.ts",
		"cat a.ts | xargs rm",
		"cat a.ts | awk '{print $1}'",
		"find . -name a -delete",
		"find . -exec rm {} ;",
		"cat /etc/hosts",
		"cat ../other/a.ts",
		"cd /tmp && ls",
		"cd .. && ls",
		// A bare listing inside a generated directory looks at output, as a named path there does (2026-11-05 session).
		"cd .octocode/tmp/agent-prompts && ls -la | head -30",
		"cd node_modules/x && ls",
		"yarn test",
		"cat a.ts && yarn test",
		"git status",
		"git status; git diff --stat; git diff | head -300",
		"git checkout main && cat a.ts",
		"FOO=1 cat a.ts",
		"cat a.ts <<EOF",
		`node -e 'console.log(1)'`,
		"git status --short; git diff; cat a.ts; node --input-type=module -e 'x'",
	])("%s is not only a workspace read", (command) => {
		expect(codeReadTool(command, cwd)).toBeUndefined();
	});
});

describe("createReadHint", () => {
	beforeAll(() => publishRoles([RESEARCH_ENTRY]));
	afterAll(() => publishRoles([]));
	const active = () => ["bash", RESEARCH.reader, RESEARCH.search];

	it("names the research server's tools by role, then stops at the per-session limit", () => {
		const hint = createReadHint(active);
		for (let i = 0; i < READ_HINT_LIMIT; i++)
			expect(hint("rg foo", cwd, "s1")).toBe(
				"Hint: for code reads like this, use `mcp__research__search_code`. Keep bash for builds, tests, scripts and git.",
			);
		expect(hint("rg foo", cwd, "s1")).toBeUndefined();
	});

	it("stays silent for a read of a log or other output, and keeps the hint for source", () => {
		const hint = createReadHint(active);
		for (const command of [
			"rg ERROR .octocode/tmp/int2-sys.log",
			"tail -n 50 build.log",
			"cat notes.txt",
			"head out.OUT",
			"ls .octocode/tmp",
			"rg foo node_modules/x/index.js",
		])
			expect(hint(command, cwd, "s1"), command).toBeUndefined();
		expect(hint("rg foo src", cwd, "s1")).toContain(`\`${RESEARCH.search}\``);
		expect(hint("sed -n '1,5p' src/a.ts", cwd, "s1")).toContain(`\`${RESEARCH.reader}\``);
		expect(hint("cat src/a.ts; tail x.log", cwd, "s1")).toContain(`\`${RESEARCH.reader}\``);
	});

	it("does not count a command it does not hint on", () => {
		const hint = createReadHint(active);
		for (let i = 0; i < READ_HINT_LIMIT + 2; i++) expect(hint("yarn test", cwd, "s1")).toBeUndefined();
		expect(hint("cat a.ts", cwd, "s1")).toContain(`\`${RESEARCH.reader}\``);
	});

	it("keeps hinting past the main-session limit when given no limit (subagents)", () => {
		const hint = createReadHint(active, Number.POSITIVE_INFINITY);
		for (let i = 0; i < READ_HINT_LIMIT + 5; i++) expect(hint("rg foo", cwd, "s1")).toContain(`\`${RESEARCH.search}\``);
	});

	it("starts over for a new session", () => {
		const hint = createReadHint(active);
		for (let i = 0; i < READ_HINT_LIMIT; i++) hint("rg foo", cwd, "s1");
		expect(hint("rg foo", cwd, "s2")).toContain(`\`${RESEARCH.search}\``);
	});

	it("stays silent without the role's tools declared", () => {
		expect(createReadHint(() => ["bash", RESEARCH.search])("cat a.ts", cwd, "s1")).toBeUndefined();
		expect(createReadHint(() => ["bash"])("rg foo", cwd, "s1")).toBeUndefined();
	});

	it("stays silent without a research server", () => {
		publishRoles([]);
		expect(createReadHint(active)("rg foo", cwd, "s1")).toBeUndefined();
		publishRoles([RESEARCH_ENTRY]);
	});
});
