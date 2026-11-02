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
		expect(shown).toContain("[1] Trust this folder");
		expect(shown).toContain("(recommended)");
		expect(shown).toContain("Trust parent packages");
		expect(shown).toContain("everything under ~/code/app/packages");
	});

	it.each([
		["1", "folder"],
		["2", "parent"],
		["3", "grandparent"],
		["n", "not-now"],
		["d", "refuse"],
		["D", "refuse"],
		[ESC, "not-now"],
	] as const)("key %j chooses %s", (key, expected) => {
		const { prompt, done } = open();
		prompt.handleInput(key);
		expect(done).toHaveBeenCalledExactlyOnceWith(expected);
	});

	it("highlights the narrowest grant, so Enter trusts this folder only", () => {
		const { prompt, done } = open();
		prompt.handleInput(ENTER);
		expect(done).toHaveBeenCalledExactlyOnceWith("folder");
	});

	it("moves with the arrow keys and confirms the highlighted row", () => {
		const { prompt, done } = open();
		prompt.handleInput(DOWN);
		prompt.handleInput(DOWN);
		prompt.handleInput(ENTER);
		expect(done).toHaveBeenCalledExactlyOnceWith("grandparent");
	});

	it("answers once, whatever is pressed after", () => {
		const { prompt, done } = open();
		prompt.handleInput("d");
		prompt.handleInput("1");
		prompt.handleInput(ESC);
		expect(done).toHaveBeenCalledExactlyOnceWith("refuse");
	});

	it("ignores an Enter typed ahead, but not a deliberate letter", () => {
		const { prompt, done } = open(input, 60_000);
		prompt.handleInput(ENTER);
		expect(done).not.toHaveBeenCalled();
		prompt.handleInput("1");
		expect(done).toHaveBeenCalledExactlyOnceWith("folder");
	});

	it("offers no parent rows when the parent is the home folder or the root, and says why", () => {
		const { prompt, done, text } = open({ path: "/Users/ada/app", projectFiles: [] });
		const shown = text();
		expect(shown).not.toContain("[2]");
		expect(shown).toContain("cannot be trusted");
		expect(shown).toContain("This folder has no project files yet.");
		prompt.handleInput("2");
		expect(done).not.toHaveBeenCalled();
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
	it("names the worktree and its repository, and maps y, n and Esc", () => {
		const answers: boolean[] = [];
		for (const key of ["y", "n", ESC, ENTER]) {
			const prompt = worktreeTrustPrompt(
				{ path: "/Users/ada/code/app-wt/feat", from: "/Users/ada/code/app" },
				(v) => answers.push(v),
				HOME,
				0,
			);
			if (key === "y")
				expect(stripAnsi(prompt.render(120).join("\n"))).toContain(
					"Trust new worktree ~/code/app-wt/feat (from ~/code/app)?",
				);
			prompt.handleInput(key);
		}
		expect(answers).toEqual([true, false, false, true]);
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
