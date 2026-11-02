import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../../src/theme/theme.ts";
import { completeCli, isSubcommand } from "../../src/cli/completion.ts";
import { worktreeTrustPrompt } from "../../src/modes/interactive/components/folder-trust-prompt.ts";
import { worktreeTrustTitle } from "../../src/octocode/worktrees/approval.ts";

beforeAll(() => initTheme("dark"));

describe("worktree question for an untrusted origin (finding 5)", () => {
	it("says the origin is untrusted too, recommends nothing and defaults to No", () => {
		const request = { path: "/w/wt1", from: "/w/evil" };
		expect(worktreeTrustTitle({ ...request, originTrusted: false })).toMatch(/\/w\/evil is not trusted either/);
		expect(worktreeTrustTitle({ ...request, originTrusted: true })).not.toMatch(/not trusted/);
		const choices: boolean[] = [];
		const untrusted = worktreeTrustPrompt(
			{ ...request, originTrusted: false },
			(value) => choices.push(value),
			undefined,
			0,
		);
		const text = untrusted.render(120).join("\n");
		expect(text).toMatch(/not trusted either/);
		expect(text).not.toMatch(/recommended/);
		untrusted.handleInput("\r");
		expect(choices).toEqual([false]);
		const trusted = worktreeTrustPrompt(
			{ ...request, originTrusted: true },
			(value) => choices.push(value),
			undefined,
			0,
		);
		expect(trusted.render(120).join("\n")).toMatch(/recommended/);
		trusted.handleInput("\r");
		expect(choices).toEqual([false, true]);
	});
});

describe("completion (finding 6)", () => {
	it("knows the trust subcommand and no longer suggests --no-approve", () => {
		expect(isSubcommand(["trust", "list"])).toBe(true);
		expect(completeCli(["trust", ""])).toEqual(["list", "add", "remove"]);
		expect(completeCli([""])).toContain("trust");
		expect(completeCli(["trust", "add", "--"])).toEqual(expect.arrayContaining(["--scope", "--yes"]));
		const installFlags = completeCli(["install", "--"]);
		expect(installFlags).toContain("--trust");
		expect(installFlags).not.toContain("--no-approve");
	});
});
