import {
	type Component,
	isKeyRelease,
	isKeyRepeat,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
	watchSelection,
} from "@octocodeai/octocode-tui";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { promptNote, promptNoteStore } from "./prompt-note.ts";
import { skillWordHighlight, skillWordSources } from "./skill-words.ts";
import { CustomEditor } from "../../theme/custom-editor.ts";
import type { Theme } from "../../theme/theme.ts";

type EditorFactory = NonNullable<ReturnType<FeatureContext["ui"]["getEditorComponent"]>>;
type Paint = Pick<Theme, "fg">;

/** What the editor needs from the permission state: the Shift+Tab step (the footer shows the mode). */
interface EditorPermission {
	/** May wait for a confirmation (`Permission.chooseMode`); the editor does not wait for it. */
	cycle(ctx: FeatureContext): unknown;
}

/** Columns the closed box takes: `│ ` on the left and ` │` on the right. */
const BOX_INSET = 2;
/** Below this width the box, labels and hint step aside and Octocode's plain rules remain. */
export const BOX_MIN_WIDTH = 24;
const LABEL = "octocode";

/**
 * The empty-prompt hint, most useful first: parts drop from the end until it fits, and the first is cut last. Octocode owns
 * `/`, `@` and `!`. The permission key is not repeated here: the footer chip always shows it.
 */
export function hintText(width: number): string {
	const parts = ["Ask about any code", "/ commands", "@ files", "! shell"];
	for (let count = parts.length; count > 1; count -= 1) {
		const text = parts.slice(0, count).join(" · ");
		if (visibleWidth(text) <= width) return text;
	}
	return truncateToWidth(parts[0], Math.max(0, width), "…");
}

/**
 * The empty editor's content row with the hint after the cursor. `row` is the row Octocode rendered (padding, the cursor
 * marker and the reverse-video cursor, then spaces); only its trailing spaces are replaced, so the cursor and IME
 * position stay where Octocode put them.
 */
export function withHint(row: string, width: number, theme: Paint): string {
	// `muted`, not `dim`: placeholder text still needs 4.5:1 contrast (WCAG 1.4.3), and `dim` falls short on light themes.
	const head = row.replace(/ +$/, "");
	const used = visibleWidth(head);
	const room = width - used - 1;
	if (room < 4) return row;
	const hint = hintText(room);
	return `${head} ${theme.fg("muted", hint)}${" ".repeat(Math.max(0, room - visibleWidth(hint)))}`;
}

/** A border rule of `width` columns with `left` and `right` labels set into it, one rule column outside each. */
export function labelledRule(width: number, left: string, right: string, rule: (text: string) => string): string {
	const room = width - 2;
	let l = left;
	let r = right;
	// A label needs one rule column between it and its neighbour; the right one yields first.
	if (visibleWidth(l) + visibleWidth(r) + 1 > room) r = "";
	if (visibleWidth(l) + 1 > room) l = "";
	const gap = Math.max(0, room - visibleWidth(l) - visibleWidth(r));
	return `${rule("─")}${l}${rule("─".repeat(gap))}${r}${rule("─")}`;
}

/** The top border's label: the `!` modes name themselves, so the tint is never their only signal. */
export function promptLabel(text: string, theme: Paint): string {
	const command = text.trimStart();
	if (command.startsWith("!!")) return theme.fg("bashMode", " !! shell · no context ");
	if (command.startsWith("!")) return theme.fg("bashMode", " ! shell ");
	return theme.fg("accent", ` ${LABEL} `);
}

function borderTint(text: string, api: (text: string) => string, theme: Paint): (text: string) => string {
	if (text.trimStart().startsWith("!")) return api;
	return (part) => theme.fg("accent", part);
}

/**
 * Draws `editor` as Octocode's prompt: a closed box (`╭─╮ │ │ ╰─╯`) tinted by the theme accent, `octocode` in the
 * idle top border (Octocode's working line takes that place during a run), a plain bottom border (the footer is the
 * one home of the permission mode), and a muted hint
 * while the prompt is empty and `hint()` holds. Octocode's rendering, input and handlers stay its own: the box wraps the rows Octocode renders at
 * the inner width, and clicks shift by the same inset, so wrapping, scrolling, the cursor marker and click-to-place
 * keep working. Colour is never the only signal: the mode is written next to the tint.
 */
export function decorateEditor(
	editor: CustomEditor,
	theme: () => Paint,
	hint: () => boolean,
	wordHint: (line: string, column: number) => string | undefined = () => undefined,
): CustomEditor {
	const render = editor.render.bind(editor);
	const handleMouse = editor.handleMouse.bind(editor);
	const setIndicator = editor.setWorkingStatusIndicator.bind(editor);
	let working = false;
	let boxed = false;
	// Octocode assigns a colour for the thinking level and the `!` mode; keep it for the `!` mode and the working line.
	let assigned = editor.borderColor;
	Object.defineProperty(editor, "borderColor", {
		configurable: true,
		enumerable: true,
		get: () => borderTint(editor.getText(), assigned, theme()),
		set: (color: (text: string) => string) => {
			assigned = color;
		},
	});
	editor.setWorkingStatusIndicator = (indicator) => {
		working = indicator !== undefined;
		setIndicator(indicator);
	};
	const rule = (text: string) => editor.borderColor(text);
	// Scroll markers and Octocode's working line (its own top border) stay as the editor draws them.
	editor.borderDecorator = (edge, width, hidden, standard) => {
		if (!boxed || hidden > 0 || (edge === "top" && working)) return standard();
		const cursor = editor.getCursor();
		// A passing note (`ctrl+c again to exit`) takes the bottom rule over the word hint while it shows.
		const word =
			edge === "bottom"
				? (promptNote() ?? wordHint(editor.getText().split("\n")[cursor.line] ?? "", cursor.col))
				: undefined;
		const label =
			edge === "top" ? promptLabel(editor.getText(), theme()) : word ? theme().fg("muted", ` ${word} `) : "";
		return labelledRule(width, label, "", rule);
	};
	editor.render = (width: number): string[] => {
		boxed = width >= BOX_MIN_WIDTH;
		if (!boxed) return render(width);
		const inner = width - BOX_INSET * 2;
		const lines = render(inner);
		const rows = editor.visibleLineCount;
		if (lines.length < rows + 2) return lines;
		const hinted = editor.getText() === "" && hint();
		const side = (row: string) =>
			`${rule("│")} ${row}${" ".repeat(Math.max(0, inner - visibleWidth(row)))} ${rule("│")}`;
		const indent = " ".repeat(BOX_INSET);
		return lines.map((line, index) => {
			if (index === 0) return `${rule("╭─")}${line}${rule("─╮")}`;
			if (index <= rows) return side(hinted && index === 1 ? withHint(line, inner, theme()) : line);
			if (index === rows + 1) return `${rule("╰─")}${line}${rule("─╯")}`;
			// Autocomplete rows sit under the box, aligned with the text.
			return `${indent}${line}${indent}`;
		});
	};
	editor.handleMouse = (event: TuiMouseEvent) =>
		handleMouse(boxed ? { ...event, x: event.x - BOX_INSET, width: event.width - BOX_INSET * 2 } : event);
	return editor;
}

/** A `CustomEditor`, or another factory's editor with the same public surface (`visibleLineCount` marks a TUI `Editor`). */
const isEditor = (component: Component): component is CustomEditor =>
	component instanceof CustomEditor ||
	("visibleLineCount" in component &&
		["getText", "setWorkingStatusIndicator", "handleMouse"].every(
			(name) => typeof (component as unknown as Record<string, unknown>)[name] === "function",
		));

/**
 * The main editor in the TUI: `app.permission.cycle` (Shift+Tab by default) cycles the permission mode before any
 * editor action sees the key; it is a reserved built-in binding, so the override
 * lives in the editor. `decorateEditor` draws the prompt. A prior
 * factory's editor is kept and decorated when it is an editor; any other component only gets the shortcut. The hint
 * shows until the conversation starts: by then the footer chip carries the Shift+Tab reminder.
 */
export function registerEditor(api: FeatureSetup, permission: EditorPermission): void {
	let installed: EditorFactory | undefined;
	let context: FeatureContext;
	let started = false;
	// A passing note in the bottom rule (`prompt-note.ts`) repaints the prompt when its text changes. Its store is
	// module-level, so the subscription ends with the session: kept, it would hold this host and its session after a
	// /new, /resume or /reload.
	let repaint: (() => void) | undefined;
	let stopNotes: (() => void) | undefined;
	api.bus.on("session_shutdown", async () => {
		stopNotes?.();
		stopNotes = undefined;
		repaint = undefined;
	});
	const sample = (ctx: FeatureContext) => {
		started = ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
	};
	api.bus.on("agent_start", async () => {
		started = true;
	});
	api.bus.on("session_tree", async (_event, ctx) => sample(ctx));
	api.bus.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		stopNotes ??= watchSelection(
			promptNoteStore,
			(note) => note.text,
			() => repaint?.(),
		);
		context = ctx;
		sample(ctx);
		const previous = ctx.ui.getEditorComponent();
		// Replacing an editor closes its active selector. Session switches only need to update the callback's context.
		if (installed && previous === installed) return;
		installed = (tui, theme, keybindings) => {
			repaint = () => tui.requestRender();
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const inner = editor.handleInput;
			const handleInput = inner?.bind(editor);
			// Preserve the editor object: Octocode copies its native action handlers and appearance onto this instance.
			editor.handleInput = (data) => {
				if (keybindings.matches(data, "app.permission.cycle")) {
					if (!isKeyRelease(data) && !isKeyRepeat(data)) void permission.cycle(context);
					return;
				}
				// The host's action owns thinking visibility; a held key toggles once, not on every repeat.
				if (keybindings.matches(data, "app.thinking.toggle") && (isKeyRelease(data) || isKeyRepeat(data))) return;
				handleInput?.(data);
			};
			// A typed run passes through this wrapper only at the keys it takes (read from the live bindings).
			if (inner) {
				Object.assign(editor.handleInput, {
					wraps: inner,
					takesTyped: (char: string) =>
						keybindings.matches(char, "app.permission.cycle") || keybindings.matches(char, "app.thinking.toggle"),
				});
			}
			const words = skillWordHighlight(
				() => skillWordSources(api.resources.getCommands()),
				(text) => context.ui.theme.fg("accent", text),
			);
			if (isEditor(editor)) editor.wordHighlight = words;
			return isEditor(editor)
				? decorateEditor(
						editor,
						() => context.ui.theme,
						() => !started,
						words.hintAt,
					)
				: editor;
		};
		ctx.ui.setEditorComponent(installed);
	});
}
