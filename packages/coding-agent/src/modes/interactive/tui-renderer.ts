import {
	type Terminal,
	type WheelScrollLines,
	ProcessTerminal,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "@octocodeai/octocode-tui";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { openItemLink, setItemClicksIntercepted } from "../../octocode/shared/item-ref.ts";
import { openTarget } from "@octocodeai/octocode-common/open-target";
import { keyText } from "../../theme/theme-tui-helpers.ts";
import { theme } from "../../theme/theme.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

interface InteractiveTuiOptions {
	readonly tuiMode: "regular" | "fullscreen";
	readonly showHardwareCursor: boolean;
	readonly logDirectory: string;
	readonly terminal?: Terminal;
	readonly onRightClickPaste?: () => void;
	readonly fullscreenCopyOnSelect?: boolean;
	readonly fullscreenWheelScrollLines?: WheelScrollLines;
	readonly openReference?: (url: string) => void;
	/** Regular mode: the most rows a replay writes (`terminal.replayRows`; 0 replays every row). */
	readonly replayRows?: number;
}

/** Composition root shared by coding-agent presentations. */
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "fullscreen" }): TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "regular" }): TuiMainScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	const terminal = options.terminal ?? new ProcessTerminal();
	// Drawn backlog ids are links only where this mode routes their click (`openUrl` below).
	setItemClicksIntercepted(options.tuiMode === "fullscreen");
	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
			scrollToEndIndicator: (rowsBelow, percent) => {
				const shortcut = keyText("tui.altScreen.bottom");
				const label = ` ↓ ${rowsBelow} rows below · ${percent}% · Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `;
				return theme.bg("selectedBg", theme.fg("text", label));
			},
			openUrl: (url) =>
				openItemLink(
					url,
					// Best effort without a host to report to: the link stays on screen to copy.
					options.openReference ?? ((target) => void openTarget(target).catch(() => undefined)),
				),
			onRightClickPaste: options.onRightClickPaste,
			copyOnSelect: options.fullscreenCopyOnSelect,
			wheelScrollLines: options.fullscreenWheelScrollLines ?? "auto",
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch (error) {
					return errorMessage(error);
				}
			},
		});
	}
	const ui = new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
	if (options.replayRows !== undefined) ui.setReplayRows(options.replayRows);
	return ui;
}

/** Stable reference for components while InteractiveMode replaces the active renderer. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}
