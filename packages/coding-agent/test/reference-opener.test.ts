import { describe, expect, it } from "vitest";
import { editorLocationCommand, locationText, referenceLocation } from "../src/modes/interactive/reference-opener.ts";
import { editorDiffCommand } from "../src/modes/interactive/editor-diff.ts";

describe("portable reference activation", () => {
	it("retains file locations and encodes paths independently from editor arguments", () => {
		const location = referenceLocation("file:///work/space%20dir/a.ts#L12:3")!;
		expect(location).toEqual({ path: "/work/space dir/a.ts", line: 12, column: 3 });
		expect(locationText(location)).toBe("/work/space dir/a.ts:12:3");
		expect(editorLocationCommand('"/Applications/Visual Studio Code.app/bin/code" --wait', location)).toEqual({
			command: "/Applications/Visual Studio Code.app/bin/code",
			args: ["--wait", "--reuse-window", "--goto", "/work/space dir/a.ts:12:3"],
		});
	});
	it("uses configured terminal editors and never evaluates path metacharacters", () => {
		const path = "/work/$(touch unsafe);a.ts";
		expect(editorLocationCommand("nvim", { path, line: 4, column: 2 })).toEqual({
			command: "nvim",
			args: ["+call cursor(4,2)", path],
		});
		expect(editorLocationCommand("nano", { path, line: 4 })).toEqual({ command: "nano", args: ["+4,1", path] });
		expect(editorLocationCommand("custom-editor --flag", { path, line: 4 })).toEqual({
			command: "custom-editor",
			args: ["--flag", path],
		});
	});
	it("preserves a quoted Windows editor path without turning it into a shell command", () => {
		expect(editorLocationCommand('"C:\\Program Files\\Editor\\editor.exe"', { path: "C:\\work\\a.ts" })).toEqual({
			command: "C:\\Program Files\\Editor\\editor.exe",
			args: ["C:\\work\\a.ts"],
		});
	});
	it("does not interpret arbitrary URI schemes or controls as files", () => {
		expect(referenceLocation("javascript:alert(1)")).toBeUndefined();
		expect(referenceLocation("https://example.com/a.ts#L2")).toBeUndefined();
		expect(referenceLocation("file:///work/a%0A.ts")).toBeUndefined();
	});
	it("passes two exact paths to GUI and terminal diff editors without evaluating shell syntax", () => {
		expect(editorDiffCommand("code --wait", ["before file", "after;$(touch unsafe)"], "/work")).toEqual({
			command: "code",
			args: ["--wait", "--reuse-window", "--diff", "/work/before file", "/work/after;$(touch unsafe)"],
		});
		expect(editorDiffCommand("nvim", ["before", "after"], "/work")?.args).toEqual([
			"-d",
			"/work/before",
			"/work/after",
		]);
		expect(editorDiffCommand("nano", ["before", "after"], "/work")).toBeUndefined();
	});
});
