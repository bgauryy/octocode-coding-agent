import { Container, getKeybindings, ListView, Spacer, Text } from "@octocodeai/octocode-tui";
import { APP_NAME } from "../../../config.ts";
import { SYSTEM_THEME_NAME } from "../../../theme/system-theme.ts";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { HintBar } from "../../../theme/theme-tui-helpers.ts";
import { answerNumber, dialogHints, listTheme, numberedRow } from "./list-kit.ts";

export interface FirstTimeSetupResult {
	theme: string;
	shareAnalytics: boolean;
}

interface FirstTimeSetupOptions {
	onThemePreview: (themeName: string) => void;
	onSubmit: (result: FirstTimeSetupResult) => void;
	onCancel: () => void;
}

const THEME_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: SYSTEM_THEME_NAME, label: "System (matches your terminal colors)" },
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
];

const ANALYTICS_OPTIONS: Array<{ value: boolean; label: string }> = [
	{ value: false, label: "Don't share (default)" },
	{ value: true, label: "Share anonymous usage data (stores a random ID in settings.json)" },
];

const SETUP_LOGO_LINES = ["██████", "██  ██", "████  ██", "██    ██"];

/** A step's answers on a numbered dialog list; `clickConfirms` is off where the answer is a privacy choice. */
function answers<T>(
	options: Array<{ value: T; label: string }>,
	clickConfirms: boolean,
): ListView<{ value: T; label: string }> {
	return new ListView({
		items: options,
		maxRows: options.length,
		theme: listTheme(),
		clickConfirms,
		row: (option, state) => numberedRow(option.label, options.indexOf(option), state),
	});
}

/**
 * First-time setup, two dialogs in a row: the theme (moving the cursor previews it), then the analytics opt-in with
 * `Don't share` first. Number keys and the arrows move the cursor, Enter confirms, Esc cancels setup. A click on the
 * selected theme confirms it; the analytics answer takes the keyboard only.
 */
export class FirstTimeSetupComponent extends Container {
	private step: "theme" | "analytics" = "theme";
	private readonly themes = answers(THEME_OPTIONS, true);
	private readonly analytics = answers(ANALYTICS_OPTIONS, false);
	private readonly options: FirstTimeSetupOptions;

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.themes.onSelectionChange = (option) => {
			this.options.onThemePreview(option.value);
			this.update();
		};
		this.themes.onSelect = () => this.confirm();
		this.analytics.onSelect = () => this.confirm();
		this.update();
	}

	/** Rebuild on theme changes, e.g. when the system theme receives the terminal's colors. */
	override invalidate(): void {
		this.update();
		super.invalidate();
	}

	// Rebuild the whole dialog on every change so theme previews recolor all text.
	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", SETUP_LOGO_LINES.join("\n")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(`Welcome to ${APP_NAME}, the minimal coding agent.`)), 1, 0));
		this.addChild(new Spacer(1));

		if (this.step === "theme") {
			this.addChild(new Text(theme.fg("text", "Pick a theme."), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.themes);
		} else {
			this.addChild(new Text(theme.fg("text", "Share anonymous usage data?"), 1, 0));
			this.addChild(
				new Text(
					theme.fg(
						"muted",
						"Opting in stores a tracking identifier in settings.json and enables anonymous\nusage analytics. This helps us to better debug, reproduce, and resolve issues\nand bugs within Octocode. The settings reference (Telemetry and privacy)\nlists what is shared; change it anytime in /settings or settings.json.",
					),
					1,
					0,
				),
			);
			this.addChild(new Spacer(1));
			this.addChild(this.analytics);
		}

		this.addChild(new Spacer(1));
		this.addChild(new HintBar(dialogHints(this.step === "theme" ? "continue" : "finish")));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private confirm(): void {
		if (this.step === "theme") {
			this.step = "analytics";
			this.update();
			return;
		}
		this.options.onSubmit({
			theme: this.themes.getSelectedItem()?.value ?? SYSTEM_THEME_NAME,
			shareAnalytics: this.analytics.getSelectedItem()?.value ?? false,
		});
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const list = this.step === "theme" ? this.themes : this.analytics;
		const picked = answerNumber(keyData, list.getItems().length);
		if (picked !== undefined) {
			const previous = list.getSelectedIndex();
			list.setSelectedIndex(picked);
			if (list === this.themes && picked !== previous) this.themes.onSelectionChange?.(THEME_OPTIONS[picked]);
			else this.update();
		} else if (keyData === "\n") this.confirm();
		else if (kb.matches(keyData, "tui.select.cancel")) this.options.onCancel();
		else list.handleInput(keyData);
	}
}
