/**
 * The `/keys` table: the shortcuts the main editor and the application answer, with the keys in force (defaults or the
 * user's keybindings.json). A row whose actions have no key is left out; the fullscreen section shows only in
 * fullscreen mode, where those keys act.
 */

import type { Keybinding } from "@octocodeai/octocode-tui";

/** One row: the actions whose keys share it (`up / down`), and what they do. Text rows (`/`, `!`) name no action. */
type Row = readonly [keys: readonly Keybinding[] | string, action: string];

interface HotkeysTableOptions {
	/** The keys bound to `action` as hints show them (`shift+tab`, `option+m`); empty when none is. */
	key(action: Keybinding): string;
	/** Fullscreen mode: the transcript keys act. */
	fullscreen: boolean;
	platform?: NodeJS.Platform;
}

function sections(options: HotkeysTableOptions): Array<readonly [title: string, rows: readonly Row[]]> {
	const newLine = `New line${(options.platform ?? process.platform) === "win32" ? " (ctrl+enter on Windows Terminal)" : ""}`;
	return [
		[
			"Navigation",
			[
				[
					["tui.editor.cursorUp", "tui.editor.cursorDown", "tui.editor.cursorLeft", "tui.editor.cursorRight"],
					"Move cursor / browse history (up from the start of the first line)",
				],
				[["tui.editor.cursorWordLeft", "tui.editor.cursorWordRight"], "Move by word"],
				[["tui.editor.cursorLineStart"], "Start of line"],
				[["tui.editor.cursorLineEnd"], "End of line"],
				[["tui.editor.jumpForward"], "Jump forward to character"],
				[["tui.editor.jumpBackward"], "Jump backward to character"],
				[["tui.editor.pageUp", "tui.editor.pageDown"], "Scroll by page"],
			],
		],
		[
			"Editing",
			[
				[["tui.input.submit"], "Send message"],
				[["tui.input.newLine"], newLine],
				[["tui.editor.deleteWordBackward"], "Delete word backwards"],
				[["tui.editor.deleteWordForward"], "Delete word forwards"],
				[["tui.editor.deleteToLineStart"], "Delete to start of line"],
				[["tui.editor.deleteToLineEnd"], "Delete to end of line"],
				[["tui.editor.yank"], "Paste the most-recently-deleted text"],
				[["tui.editor.yankPop"], "Cycle through the deleted text after pasting"],
				[["tui.editor.undo"], "Undo"],
			],
		],
		...(options.fullscreen
			? ([
					[
						"Fullscreen",
						[
							[["tui.altScreen.pageUp", "tui.altScreen.pageDown"], "Scroll the transcript by page"],
							[["tui.altScreen.halfPageUp", "tui.altScreen.halfPageDown"], "Scroll the transcript by half a page"],
							[["tui.altScreen.lineUp", "tui.altScreen.lineDown"], "Scroll the transcript by line"],
							[["tui.altScreen.top", "tui.altScreen.bottom"], "Transcript start / end (follows new output)"],
							[["tui.altScreen.previousPrompt"], "Jump to the previous marked message"],
							[["tui.altScreen.nextPrompt"], "Jump to the next marked message"],
							[["tui.altScreen.search"], "Search the transcript (also `/find`)"],
							[["tui.altScreen.toggleMouse"], "Hand the mouse to the terminal's selection, or take it back"],
						],
					],
				] as const)
			: []),
		[
			"Sessions",
			[
				[["app.session.new"], "Start a new session (`/new`)"],
				[["app.session.tree"], "Open the session tree (`/tree`)"],
				[["app.session.fork"], "Fork the session (`/fork`)"],
				[["app.session.resume"], "Resume a session (`/resume`)"],
				[["app.session.loadEarlier"], "Load earlier transcript entries"],
			],
		],
		[
			"Other",
			[
				[["tui.input.tab"], "Path completion / accept autocomplete"],
				[["app.interrupt"], "Cancel autocomplete / interrupt the run"],
				[["app.clear"], "Interrupt the run, else clear the editor (first) / exit (second)"],
				[["app.exit"], "Exit (when editor is empty)"],
				[["app.suspend"], "Suspend to background"],
				[["app.permission.cycle"], "Cycle the permission mode"],
				[["app.thinking.cycle"], "Cycle thinking level"],
				[["app.model.cycleForward", "app.model.cycleBackward"], "Cycle models"],
				[["app.model.select"], "Open model selector"],
				[["app.tools.expand"], "Toggle tool output and long response expansion"],
				[["app.thinking.toggle"], "Toggle thinking block visibility"],
				[["app.editor.external"], "Edit message in external editor"],
				[["app.message.copy"], "Copy selection or last assistant message"],
				[["app.message.followUp"], "Queue follow-up message"],
				[["app.message.dequeue"], "Restore the last queued message (`/queue` manages all)"],
				[["app.clipboard.pasteImage"], "Paste files on macOS, images, or text from clipboard"],
				["/", "Slash commands"],
				["!", "Run bash command"],
				["!!", "Run bash command (excluded from context)"],
			],
		],
	];
}

/** The table as Markdown: one section per heading, rows without a key left out. */
export function hotkeysMarkdown(options: HotkeysTableOptions): string {
	const keysOf = (keys: Row[0]): string =>
		typeof keys === "string"
			? `\`${keys}\``
			: keys
					.map((action) => options.key(action))
					.filter(Boolean)
					.map((key) => `\`${key}\``)
					.join(" / ");
	return sections(options)
		.map(([title, rows]) => {
			const lines = rows.flatMap(([keys, action]) => {
				const shown = keysOf(keys);
				return shown ? [`| ${shown} | ${action} |`] : [];
			});
			return lines.length > 0 ? `**${title}**\n| Key | Action |\n|-----|--------|\n${lines.join("\n")}` : "";
		})
		.filter(Boolean)
		.join("\n\n");
}
