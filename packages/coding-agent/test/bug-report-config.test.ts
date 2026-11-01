import {
	Container,
	Editor,
	getKeybindings,
	setKeybindings,
	stripTerminalSequences,
	TuiMainScreen,
} from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { BUG_REPORT_URL_ENV, bugReportUploadTarget, uploadBugReport } from "../src/core/bug-report-upload.ts";
import type { BugReportBundle } from "../src/core/bug-report.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { reportBug } from "../src/modes/interactive/bug-report.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { getEditorTheme, initTheme } from "../src/theme/theme.ts";

beforeAll(() => initTheme("dark"));
const previous = process.env[BUG_REPORT_URL_ENV];
afterEach(() => {
	if (previous === undefined) delete process.env[BUG_REPORT_URL_ENV];
	else process.env[BUG_REPORT_URL_ENV] = previous;
});

describe("bug report upload configuration", () => {
	it("parses the configured service once: valid, malformed or unset", () => {
		expect(bugReportUploadTarget("https://reports.example/")).toEqual({ url: new URL("https://reports.example/") });
		expect(bugReportUploadTarget("not a url")).toEqual({ error: expect.stringContaining(BUG_REPORT_URL_ENV) });
		expect(bugReportUploadTarget("file:///tmp/x")).toEqual({ error: expect.any(String) });
		expect(bugReportUploadTarget("  ")).toBeUndefined();
	});

	it("rejects an upload to a malformed URL with the configuration error, not a TypeError", async () => {
		await expect(uploadBugReport({} as BugReportBundle, { gatewayUrl: "not a url" })).rejects.toThrow(
			/OCTOCODE_BUG_REPORT_URL is not a valid/,
		);
	});

	it("still offers Export as Zip when OCTOCODE_BUG_REPORT_URL is malformed", async () => {
		process.env[BUG_REPORT_URL_ENV] = "not a url";
		const previousKeybindings = getKeybindings();
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		try {
			const ui = new TuiMainScreen(new VirtualTerminal());
			const editorContainer = new Container();
			const editor = new Editor(ui, getEditorTheme());
			const session = {
				model: undefined,
				settingsManager: { getExternalEditorCommand: () => "nano" },
			} as unknown as AgentSession;
			const showStatus = vi.fn();
			const showError = vi.fn();
			const report = reportBug({ session, ui, editorContainer, editor, keybindings, showStatus, showError });

			const descriptionEditor = editorContainer.children[0];
			if (!(descriptionEditor instanceof ExtensionEditorComponent)) throw new Error("Missing description editor");
			descriptionEditor.handleInput("\r");
			for (const _question of ["transcript", "summary"]) {
				await vi.waitFor(() => expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent));
				const selector = editorContainer.children[0] as ExtensionSelectorComponent;
				selector.handleInput("j");
				selector.handleInput("\r");
			}

			await vi.waitFor(() => expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent));
			const delivery = editorContainer.children[0] as ExtensionSelectorComponent;
			const text = delivery.render(160).map(stripTerminalSequences).join("\n");
			expect(text).toContain("Export as Zip");
			expect(text).not.toContain("Upload Report");
			expect(text).toContain("not a valid http(s) URL");

			delivery.handleInput("j");
			delivery.handleInput("\r");
			await report;
			expect(showStatus).toHaveBeenCalledWith("Bug report cancelled");
			expect(showError).not.toHaveBeenCalled();
		} finally {
			setKeybindings(previousKeybindings);
		}
	});
});
