import {
	type Component,
	Container,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@octocodeai/octocode-tui";
import { SYSTEM_THEME_NAME } from "../../../../theme/system-theme.ts";
import { getSettingsListTheme, parseAutoThemeSetting, type ThemeAppearance, theme } from "../../../../theme/theme.ts";
import { SelectSubmenu } from "../settings-submenu.ts";
import type { SettingsCallbacks } from "./types.ts";

function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
		...(name === SYSTEM_THEME_NAME ? { description: "Theme created from your terminal's colors" } : {}),
	}));
}

const AUTOMATIC_THEME_VALUE = "/";

/** The system theme comes first, then automatic mode, then the remaining themes. */
function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	const items = themeItems(availableThemes, currentTheme);
	const systemIndex = items.findIndex((item) => item.value === SYSTEM_THEME_NAME);
	const system = systemIndex === -1 ? [] : items.splice(systemIndex, 1);
	return [
		...system,
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...items,
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, SYSTEM_THEME_NAME);
	return { lightTheme: themeName, darkTheme: themeName };
}

export class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: ThemeAppearance;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: ThemeAppearance,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			SYSTEM_THEME_NAME,
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes, this.singleTheme),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes, currentValue),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}
