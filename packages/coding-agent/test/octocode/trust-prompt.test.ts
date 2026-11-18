import { setKeybindings } from "@octocodeai/octocode-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import {
	type TrustChoice,
	folderTrustPrompt,
	type TrustPromptInput,
	worktreeTrustPrompt,
} from "../../src/modes/interactive/components/folder-trust-prompt.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { homeFolderMessage, notTrustedExitLine, refusedFolderMessage } from "../../src/octocode/trust/messages.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

const input: TrustPromptInput = {
	path: "/Users/ada/code/app/packages/web",
	parent: "/Users/ada/code/app/packages",
	grandparent: "/Users/ada/code/app",
	projectFiles: ["AGENTS.md", ".octocode/settings.json", ".mcp.json"],
};
const HOME = "/Users/ada";
const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

function open(files = input, armDelayMs = 0) {
	const done = vi.fn<(choice: TrustChoice) => void>();
	const prompt = folderTrustPrompt(files, done, HOME, armDelayMs);
	return { prompt, done, text: () => stripAnsi(prompt.render(120).join("\n")) };
}

describe("the folder trust prompt", () => {
	it("fits one screen and says what trust allows, which folder, and what was found by name", () => {
		const { prompt, text } = open();
		expect(prompt.render(100).length).toBeLessThanOrEqual(24);
		const shown = text();
		expect(shown).toContain("Do you trust this folder?");
		expect(shown).toMatch(/^\s*\/Users\/ada\/code\/app\/packages\/web\s*$/m);
		expect(shown).toContain("run commands");
		expect(shown).toContain("Nothing here has been read or run yet.");
		expect(shown).toContain("Found here: AGENTS.md, .octocode/settings.json, .mcp.json");
		expect(shown).toMatch(/^› 1\. Not now {2}exit; ask again next time$/m);
		expect(shown).toMatch(/^ {2}2\. Trust this folder {2}\(recommended\)$/m);
		expect(shown).toMatch(/^ {2}5\. Do not trust/m);
		expect(shown).toContain("Trust parent packages");
		expect(shown).toContain("everything under ~/code/app/packages");
	});

	it.each([
		["1", "not-now"],
		["2", "folder"],
		["3", "parent"],
		["4", "grandparent"],
		["5", "refuse"],
	] as const)("number key %j moves to %s and Enter confirms it", (key, expected) => {
		const { prompt, done } = open();
		prompt.handleInput(key);
		expect(done).not.toHaveBeenCalled();
		prompt.handleInput(ENTER);
		expect(done).toHaveBeenCalledExactlyOnceWith(expected);
	});

	it("Esc answers Not now", () => {
		const { prompt, done } = open();
		prompt.handleInput(ESC);
		expect(done).toHaveBeenCalledExactlyOnceWith("not-now");
	});

	it("starts on Not now, so a bare Enter grants nothing", () => {
		const { prompt, done } = open();
		prompt.handleInput(ENTER);
		expect(done).toHaveBeenCalledExactlyOnceWith("not-now");
	});

	it("moves with the arrow keys, stops at the ends and confirms the highlighted row", () => {
		const { prompt, done } = open();
		prompt.handleInput("\x1b[A");
		prompt.handleInput(DOWN);
		prompt.handleInput(DOWN);
		prompt.handleInput(ENTER);
		expect(done).toHaveBeenCalledExactlyOnceWith("parent");
	});

	it("answers once, whatever is pressed after", () => {
		const { prompt, done } = open();
		prompt.handleInput("5");
		prompt.handleInput(ENTER);
		prompt.handleInput("2");
		prompt.handleInput(ENTER);
		prompt.handleInput(ESC);
		expect(done).toHaveBeenCalledExactlyOnceWith("refuse");
	});

	it("ignores an Enter typed ahead; number keys still move the cursor", () => {
		const { prompt, done } = open(input, 60_000);
		prompt.handleInput("2");
		prompt.handleInput(ENTER);
		expect(done).not.toHaveBeenCalled();
		expect(prompt.getSelected()).toBe("folder");
	});

	it("offers no parent rows when the parent is the home folder or the root, and says why", () => {
		const { prompt, done, text } = open({ path: "/Users/ada/app", projectFiles: [] });
		const shown = text();
		expect(shown).not.toContain("Trust parent");
		expect(shown).toContain("cannot be trusted");
		expect(shown).toContain("This folder has no project files yet.");
		expect(shown).toMatch(/1\. Not now[\s\S]*2\. Trust this folder[\s\S]*3\. Do not trust/);
		prompt.handleInput("4");
		prompt.handleInput(ENTER);
		expect(done).toHaveBeenCalledExactlyOnceWith("not-now");
	});

	it("never offers a grandparent without a parent", () => {
		const { text } = open({ path: "/Users/ada/app", grandparent: "/Users", projectFiles: [] });
		expect(text()).not.toContain("grandparent");
	});

	it("lists at most a few file names", () => {
		const many = Array.from({ length: 12 }, (_, index) => `skill-${index}.md`);
		const shown = open({ ...input, projectFiles: many }).text();
		expect(shown).toContain("and 4 more");
	});
});

describe("the worktree trust question", () => {
	it("names the worktree and its repository; No comes first, 2 then Enter trusts", () => {
		const answers: boolean[] = [];
		for (const keys of [["2", ENTER], ["1", ENTER], [ESC], [ENTER]]) {
			const prompt = worktreeTrustPrompt(
				{ path: "/Users/ada/code/app-wt/feat", from: "/Users/ada/code/app" },
				(v) => answers.push(v),
				HOME,
				0,
			);
			if (keys[0] === "2") {
				const shown = stripAnsi(prompt.render(120).join("\n"));
				expect(shown).toContain("Trust new worktree ~/code/app-wt/feat (from ~/code/app)?");
				expect(shown).toMatch(/^› 1\. No {2}do not create the worktree\n {2}2\. Trust this worktree/m);
			}
			for (const key of keys) prompt.handleInput(key);
		}
		expect(answers).toEqual([true, false, false, false]);
	});
});

describe("trust messages", () => {
	it("hints how to change a recorded refusal, in one line", () => {
		const line = refusedFolderMessage("/work/app");
		expect(line).not.toContain("\n");
		expect(line).toContain("octocode trust add /work/app");
	});

	it("suggests a project folder for the home folder and the root", () => {
		expect(homeFolderMessage("/Users/ada", "home")).toMatch(/home folder[\s\S]*Open a project folder/);
		expect(homeFolderMessage("/", "filesystem-root")).toMatch(/filesystem root[\s\S]*Open a project folder/);
	});

	it("tells the two exits apart", () => {
		expect(notTrustedExitLine("/w", "not-now")).toContain("will ask again");
		expect(notTrustedExitLine("/w", "refuse")).toContain("octocode trust add /w");
	});
});
