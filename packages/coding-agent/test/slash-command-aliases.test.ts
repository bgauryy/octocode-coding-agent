import { describe, expect, it } from "vitest";
import {
	COMMAND_ALIASES,
	parseSlashCommand,
	reservedCommandNames,
	SLASH_MENU_ORDER,
} from "../src/core/slash-commands.ts";

describe("Claude Code command aliases", () => {
	it.each([
		["/exit", "quit"],
		["/config", "configuration"],
		["/settings", "configuration"],
		["/release-notes", "changelog"],
		["/continue", "resume"],
		["/doctor", "debug"],
		["/checkpoint", "rewind"],
	])("%s runs /%s with its arguments", (text, name) => {
		expect(parseSlashCommand(`${text} some args`)).toEqual({ name, args: "some args" });
	});

	it("keeps canonical and unknown names unchanged", () => {
		expect(parseSlashCommand("/quit")).toEqual({ name: "quit", args: "" });
		expect(parseSlashCommand("/nope x")).toEqual({ name: "nope", args: "x" });
	});

	it("points every alias at a known command and reserves it", () => {
		const reserved = reservedCommandNames([]);
		for (const [alias, target] of COMMAND_ALIASES) {
			expect(SLASH_MENU_ORDER).toContain(target);
			expect(SLASH_MENU_ORDER).not.toContain(alias);
			expect(reserved.has(alias)).toBe(true);
		}
	});
});
