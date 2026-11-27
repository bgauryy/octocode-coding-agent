import { describe, expect, it } from "vitest";
import { NO_NEXT_STEP, nextStepFor } from "../src/core/command-next-steps.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("next-step hints", () => {
	it("gives every built-in command a hint or a stated reason for none", () => {
		const missing = BUILTIN_SLASH_COMMANDS.filter(
			(command) => !nextStepFor(command.name) && !NO_NEXT_STEP[command.name],
		).map((command) => command.name);
		expect(missing).toEqual([]);
	});

	it("keeps exceptions and hints apart", () => {
		for (const key of Object.keys(NO_NEXT_STEP)) {
			const [name, args = ""] = key.split(" ");
			expect(nextStepFor(name, args), key).toBeUndefined();
		}
	});

	it("prefers a command's entry for its first argument, and an argument's exception over the command's entry", () => {
		expect(nextStepFor("trust")).toBeUndefined();
		expect(nextStepFor("trust", " list ")?.[0]).toBe("/trust add [path]");
		expect(nextStepFor("worktree", "new demo")?.[0]).toBe("/worktree switch <name>");
		expect(nextStepFor("worktree", "remove demo")).toEqual(nextStepFor("worktree"));
		expect(nextStepFor("backlog")).toBeDefined();
		expect(nextStepFor("backlog", "tui")).toBeUndefined();
	});

	it("never repeats the line just typed, and leaves a bare page opener to its own key bar", () => {
		expect(nextStepFor("usage", " 30d ")).toBeUndefined();
		expect(nextStepFor("usage", "7d")?.[0]).toBe("/usage 30d");
		expect(nextStepFor("agents", "stats")).toBeUndefined();
		expect(nextStepFor("permissions", "log")).toBeUndefined();
		// Bare, these open a page or picker; with arguments they print a result and get their entry.
		expect(nextStepFor("permissions")).toBeUndefined();
		expect(nextStepFor("permissions", "workspace")?.[0]).toBe("/permissions log");
		expect(nextStepFor("realm")?.[0]).toBe("/realm places");
		expect(nextStepFor("realm", "places")).toBeUndefined();
		expect(nextStepFor("modelsettings")).toBeUndefined();
		expect(nextStepFor("messages")).toBeUndefined();
	});

	it("points each hint at a command that exists", () => {
		const names = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		for (const command of BUILTIN_SLASH_COMMANDS) {
			const step = nextStepFor(command.name);
			if (!step) continue;
			const target = /^\/(\S+)/.exec(step[0])?.[1];
			expect(target && names.has(target), `${command.name} -> ${step[0]}`).toBe(true);
		}
	});
});
