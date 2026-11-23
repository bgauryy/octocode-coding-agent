import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { setupEditorSubmitHandler } from "../src/modes/interactive/interactive-mode/command-dispatch.ts";
import { featureCommandHint } from "../src/modes/interactive/interactive-mode/next-step-hint.ts";
import { createSessionUI } from "../src/modes/interactive/interactive-mode/session-ui.ts";
import { cancelledText } from "../src/octocode/shared/commands.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

/** A host whose warnings and errors are the real transcript notices, so the dispatcher sees them as it does in the app. */
function mode() {
	const children: Array<{ render(width: number): string[] }> = [];
	const instance: any = {
		defaultEditor: {},
		chatContainer: { addChild: (child: { render(width: number): string[] }) => children.push(child) },
		ui: { requestRender: vi.fn() },
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		uiStore: createUiStore(),
		getSlashCommands: () => BUILTIN_SLASH_COMMANDS,
		session: {
			isStreaming: false,
			featureHost: {
				getRegisteredCommands: () => [],
				getCommand: (name: string) => (["worktree", "remote"].includes(name) ? { name } : undefined),
				hasHandlers: () => false,
			},
		},
	};
	setupEditorSubmitHandler(createFakeHost(instance));
	const text = () =>
		children
			.flatMap((child) => child.render(100))
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
	return { instance, text, children };
}

beforeAll(() => initTheme("dark"));

describe("a command's next-step hint after it runs", () => {
	it("follows a built-in that did its job, and the line it ran is in the prompt history", async () => {
		const { instance, text } = mode();
		instance.handleHotkeysCommand = vi.fn();
		await instance.defaultEditor.onSubmit("/keys");
		expect(text()).toMatch(/\/help\s+find a command/);
		expect(instance.editor.addToHistory).toHaveBeenCalledWith("/keys");
	});

	it("is left out when the built-in warned or failed: the notice already says what to do", async () => {
		const { instance, text } = mode();
		instance.handleCopyCommand = () => instance.showWarning("No agent messages to copy yet.");
		instance.handleExportCommand = () => instance.showError("Could not write the file.");
		await instance.defaultEditor.onSubmit("/copy");
		await instance.defaultEditor.onSubmit("/export");
		expect(text()).toContain("No agent messages to copy yet.");
		expect(text()).not.toMatch(/save the whole session|share it as a private gist/);
		// A later successful run still gets its hint: the check compares counts per run.
		instance.handleCopyCommand = vi.fn();
		await instance.defaultEditor.onSubmit("/copy");
		expect(text()).toMatch(/\/export\s+save the whole session/);
	});

	it("is left out after a built-in the user cancelled at its confirmation", async () => {
		const { instance, text } = mode();
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-hint-")), "saved.jsonl");
		// /import checks the file is a session before it asks, so the stand-in is a session header, not an empty file.
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "saved", timestamp: "2026-01-01T00:00:00.000Z", cwd: os.tmpdir() })}\n`,
		);
		instance.showStatus = vi.fn();
		instance.showConfirmDialog = vi.fn(async () => false);
		await instance.defaultEditor.onSubmit(`/import ${file}`);
		expect(instance.showStatus).toHaveBeenCalledWith("Import cancelled");
		expect(text()).not.toContain("browse the imported branches");
	});

	it("is left out after a feature command that warned, as after one that threw", () => {
		const { instance, text } = mode();
		const done = featureCommandHint(instance, "/worktree new demo");
		instance.showError("Worktree not created: it was not trusted.");
		done("handled", undefined);
		expect(text()).not.toContain("move this session into it");
		featureCommandHint(instance, "/worktree new demo")("handled", undefined);
		expect(text()).toMatch(/\/worktree switch <name>\s+move this session into it/);
	});

	it("is left out after a feature command the user cancelled at its confirmation", () => {
		const { instance, children } = mode();
		const ui = createSessionUI(instance);
		const done = featureCommandHint(instance, "/remote");
		ui.notify(cancelledText("published"), "info");
		done("handled", undefined);
		const shown = children.flatMap((child) => child.render(100)).join("\n");
		expect(shown).toContain("Cancelled: nothing was published.");
		expect(shown).not.toContain("end remote access");
		// Any other info notice is a result, and the hint follows it.
		const next = featureCommandHint(instance, "/remote");
		ui.notify("Published a control link.", "info");
		next("handled", undefined);
		expect(children.flatMap((child) => child.render(100)).join("\n")).toContain("end remote access");
	});
});
