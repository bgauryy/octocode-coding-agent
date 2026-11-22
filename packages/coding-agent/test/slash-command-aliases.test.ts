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
		["/config", "settings"],
		["/configuration", "settings"],
		["/release-notes", "changelog"],
		["/continue", "resume"],
		["/doctor", "debug"],
		["/checkpoint", "rewind"],
	])("%s runs /%s with its arguments", (text, name) => {
		expect(parseSlashCommand(`${text} some args`)).toEqual({ name, args: "some args" });
	});

	it("runs /plugins and /hooks as /harness, and /mcp enable as /settings", () => {
		expect(parseSlashCommand("/plugins disable x")).toEqual({ name: "harness", args: "disable x" });
		expect(parseSlashCommand("/hooks events")).toEqual({ name: "harness", args: "hooks events" });
		expect(parseSlashCommand("/hooks")).toEqual({ name: "harness", args: "hooks" });
		expect(parseSlashCommand("/mcp enable fs -l")).toEqual({ name: "settings", args: "enable mcp:fs --local" });
		expect(parseSlashCommand("/mcp disable fs")).toEqual({ name: "settings", args: "disable mcp:fs" });
		expect(parseSlashCommand("/mcp list")).toEqual({ name: "mcp", args: "list" });
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
