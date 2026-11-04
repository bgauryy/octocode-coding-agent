import {
	type Component,
	Container,
	getKeybindings,
	type Input,
	Spacer,
	Text,
	truncateToWidth,
} from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import { hintLine, keyText } from "../keybinding-hints.ts";
import type { SessionInfo } from "../../../../core/session-manager.ts";
import { rowTitle } from "./row.ts";
import type { SessionAction } from "./types.ts";

/** The rename form: a title, the input and how to save or cancel. */
export function renamePanel(input: Input): Component {
	const panel = new Container();
	panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
	panel.addChild(new Spacer(1));
	panel.addChild(input);
	panel.addChild(new Spacer(1));
	panel.addChild(
		new Text(
			hintLine([
				[keyText("tui.select.confirm"), "save"],
				[keyText("tui.select.cancel"), "cancel"],
			]),
			1,
			0,
		),
	);
	return panel;
}

/**
 * The menu of `actions` for `session`. A chosen action runs after `close()`, since it may close the picker; a failure
 * goes to `fail` so it shows if the picker stays.
 */
export function actionsMenuFor(
	session: SessionInfo,
	actions: readonly SessionAction[],
	close: () => void,
	fail: (label: string, error: unknown) => void,
): ActionsMenu {
	return new ActionsMenu(
		rowTitle(session),
		actions,
		(action) => {
			close();
			void Promise.resolve()
				.then(() => action.run(session))
				.catch((error) => fail(action.label, error));
		},
		close,
	);
}

/** The host's actions for one session, as a short list: up and down choose, confirm runs, cancel goes back. */
export class ActionsMenu implements Component {
	private selected = 0;
	private readonly title: string;
	private readonly actions: readonly SessionAction[];
	private readonly onPick: (action: SessionAction) => void;
	private readonly onCancel: () => void;

	constructor(
		title: string,
		actions: readonly SessionAction[],
		onPick: (action: SessionAction) => void,
		onCancel: () => void,
	) {
		this.title = title;
		this.actions = actions;
		this.onPick = onPick;
		this.onCancel = onCancel;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [` ${truncateToWidth(theme.bold(this.title), Math.max(1, width - 2), "…")}`, ""];
		this.actions.forEach((action, i) => {
			const label = truncateToWidth(action.label, Math.max(1, width - 4), "…");
			lines.push(i === this.selected ? ` ${theme.fg("accent", `› ${label}`)}` : `   ${label}`);
		});
		lines.push(
			"",
			truncateToWidth(
				` ${hintLine([
					[keyText("tui.select.confirm"), "run"],
					[keyText("tui.select.cancel"), "back"],
				])}`,
				width,
				"…",
			),
		);
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (kb.matches(data, "tui.select.down")) this.selected = Math.min(this.actions.length - 1, this.selected + 1);
		else if (kb.matches(data, "tui.select.confirm")) this.onPick(this.actions[this.selected]);
		else if (kb.matches(data, "tui.select.cancel")) this.onCancel();
	}
}
