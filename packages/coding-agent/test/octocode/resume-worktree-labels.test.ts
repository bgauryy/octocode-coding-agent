import { mkdirSync } from "node:fs";
import path from "node:path";
import { setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { SessionInfo } from "../../src/core/session-manager.ts";
import { SessionList } from "../../src/modes/interactive/components/session-selector/session-list.ts";
import { checkoutLabel, octocodeWorktreeAt, worktreeRecoveryHint } from "../../src/core/worktree-path.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { tmp } from "./helpers.ts";
import { makeRepo, sh, type TestRepo } from "./worktree-fixture.ts";

const stripAnsi = (text: string): string => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

const session = (id: string, cwd: string): SessionInfo => ({
	path: `/tmp/${id}.jsonl`,
	id,
	cwd,
	created: new Date(0),
	modified: new Date(0),
	messageCount: 3,
	firstMessage: `message of ${id}`,
	allMessagesText: `message of ${id}`,
});

const repos: TestRepo[] = [];
afterEach(() => {
	while (repos.length) repos.pop()?.cleanup();
});

/** A repository with a worktree `x` under `.octocode/worktrees` and a linked worktree `ext` beside it. */
function repoWithWorktrees(): { root: string; inside: string; outside: string } {
	const repo = makeRepo();
	repos.push(repo);
	const inside = path.join(repo.root, ".octocode", "worktrees", "x");
	const outside = path.join(path.dirname(repo.root), "ext");
	mkdirSync(path.dirname(inside), { recursive: true });
	sh(repo.root, "worktree", "add", "-q", "-b", "worktree-x", inside);
	sh(repo.root, "worktree", "add", "-q", "-b", "ext-branch", outside);
	return { root: repo.root, inside, outside };
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("checkoutLabel", () => {
	it("tells the main checkout, an Octocode worktree and any other linked worktree apart", () => {
		const { root, inside, outside } = repoWithWorktrees();
		expect(checkoutLabel(root)).toBe("main");
		expect(checkoutLabel(inside)).toBe("worktree x");
		expect(checkoutLabel(outside)).toBe("worktree ext");
	});

	it("labels nothing for a plain folder, a subfolder or a missing one", () => {
		const { root } = repoWithWorktrees();
		const plain = tmp("octocode-plain-");
		expect(checkoutLabel(plain)).toBeUndefined();
		expect(checkoutLabel(path.join(root, "a.txt"))).toBeUndefined();
		expect(checkoutLabel(path.join(plain, "gone"))).toBeUndefined();
	});

	it("still names an Octocode worktree whose folder was removed, from its path alone", () => {
		const gone = path.join(tmp("octocode-gone-"), ".octocode", "worktrees", "old", "src");
		expect(checkoutLabel(gone)).toBe("worktree old");
		expect(octocodeWorktreeAt(gone)).toEqual({
			main: path.dirname(path.dirname(path.dirname(path.dirname(gone)))),
			name: "old",
		});
	});

	it("suggests recreating only a folder that was an Octocode worktree", () => {
		expect(worktreeRecoveryHint("/repo/.octocode/worktrees/old")).toContain("/worktree new old");
		expect(worktreeRecoveryHint("/repo/.octocode/worktrees/old")).toContain("octocode --worktree old");
		expect(worktreeRecoveryHint("/repo/packages/app")).toBeUndefined();
		expect(worktreeRecoveryHint("/repo/.octocode/worktrees")).toBeUndefined();
	});
});

describe("the /resume all picker", () => {
	const render = (sessions: SessionInfo[], width: number): string[] =>
		new SessionList(sessions, true, "recent", "all", new KeybindingsManager()).render(width).map(stripAnsi);

	/** In the All scope a folder's sessions sit under one group label that carries the checkout label. */
	it("labels a main-checkout group `main` and a worktree group `worktree <name>`", () => {
		const { root, inside } = repoWithWorktrees();
		const lines = render([session("in-main", root), session("in-worktree", inside)], 400);
		expect(lines.find((line) => /\bmain \S*repo\b/.test(line))).toBeDefined();
		expect(lines.find((line) => /worktree x \S*\.octocode\/worktrees\/x/.test(line))).toBeDefined();
		// The label is above its row, not repeated on it.
		expect(lines.find((line) => line.includes("message of in-main"))).not.toMatch(/\bmain \S*repo\b/);
	});

	it("keeps every row within a narrow terminal and shows the label when the path no longer fits", () => {
		const { inside } = repoWithWorktrees();
		const lines = render([session("in-worktree", inside)], 60);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		const label = lines.find((line) => line.includes("worktree x"));
		expect(label).toBeDefined();
		expect(label).not.toContain(".octocode");
	});

	it("shows a folder that is no checkout as its path only", () => {
		const plain = tmp("octocode-plain-");
		const label = render([session("elsewhere", plain)], 200).find((line) => line.includes(path.basename(plain)));
		expect(label).toBeDefined();
		expect(label).not.toMatch(/\b(main|worktree)\b/);
	});
});
