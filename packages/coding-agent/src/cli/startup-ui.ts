import {
	getTerminalColorMode,
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
	TuiMainScreen,
} from "@octocodeai/octocode-tui";
import { existsSync } from "node:fs";
import { requireInput } from "./no-input.ts";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { areExperimentalFeaturesEnabled } from "../core/experimental.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { DialogInputComponent } from "../modes/interactive/components/dialog-input.ts";
import { DialogSelectorComponent } from "../modes/interactive/components/dialog-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import { SYSTEM_THEME_NAME } from "../theme/system-theme.ts";
import {
	getTerminalTheme,
	initTheme,
	loadThemeFromPath,
	markTerminalColorsPending,
	resolveThemeSetting,
	setRegisteredThemes,
	setTerminalColors,
	setTheme,
	type Theme,
} from "../theme/theme.ts";
import { requestTerminalColors } from "../modes/interactive/theme/theme-controller.ts";

const OFFICIAL_PACKAGE_NAME = "@octocodeai/octocode-agent";
const OFFICIAL_APP_NAME = "octocode";
const OFFICIAL_CONFIG_DIR_NAME = ".octocode";

interface DistributionMetadata {
	packageName: string;
	appName: string;
	configDirName: string;
}

function isOfficialDistribution({ packageName, appName, configDirName }: DistributionMetadata): boolean {
	return (
		packageName === OFFICIAL_PACKAGE_NAME && appName === OFFICIAL_APP_NAME && configDirName === OFFICIAL_CONFIG_DIR_NAME
	);
}

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// Startup prompts should not fail because a theme is broken. The normal
			// resource loader reports theme diagnostics later in startup.
		}
	}
	return themes;
}

let cachedStartupThemes: { key: string; themes: Theme[] } | undefined;
let startupScopeDepth = 0;
let sharedStartupTui: { ui: TUI; started: boolean } | undefined;

/**
 * Runs a sequence of startup prompts on one shared `TuiMainScreen` lifecycle instead of tearing down and recreating
 * the terminal between trust, `--resume`, missing-cwd, and first-time setup prompts. The shared TUI is created lazily
 * on the first prompt and stopped once when the outermost scope exits.
 */
export async function withStartupTuiScope<T>(run: () => Promise<T>): Promise<T> {
	startupScopeDepth++;
	try {
		return await run();
	} finally {
		startupScopeDepth--;
		if (startupScopeDepth === 0 && sharedStartupTui) {
			const { ui, started } = sharedStartupTui;
			sharedStartupTui = undefined;
			if (started) {
				await clearStartupTui(ui);
				ui.stop();
			}
		}
	}
}

/** Acquire a startup TUI: reuses the active scoped TUI when inside `withStartupTuiScope`, else creates a fresh one. */
export async function acquireStartupTui(
	settingsManager: SettingsManager,
): Promise<{ ui: TUI; shared: boolean; started: boolean }> {
	if (startupScopeDepth > 0) {
		if (!sharedStartupTui) {
			sharedStartupTui = { ui: await createStartupTui(settingsManager), started: false };
		} else {
			sharedStartupTui.ui.clear();
		}
		return { ui: sharedStartupTui.ui, shared: true, started: sharedStartupTui.started };
	}
	return { ui: await createStartupTui(settingsManager), shared: false, started: false };
}

/** Start (or repaint) a startup TUI acquired via `acquireStartupTui`. */
export function mountStartupTui(
	handle: { ui: TUI; shared: boolean; started: boolean },
	settingsManager: SettingsManager,
): void {
	if (handle.started) {
		handle.ui.requestRender(true);
		return;
	}
	startStartupTui(handle.ui, settingsManager);
	handle.started = true;
	if (handle.shared && sharedStartupTui?.ui === handle.ui) {
		sharedStartupTui.started = true;
	}
}

/** Release a startup TUI: clears the screen when shared (stopping on scope exit), or clears and stops when standalone. */
export async function releaseStartupTui(handle: { ui: TUI; shared: boolean }): Promise<void> {
	if (handle.shared) {
		handle.ui.clear();
		handle.ui.requestRender();
		return;
	}
	await clearStartupTui(handle.ui);
	handle.ui.stop();
}

async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const key = `${cwd}\0${agentDir}`;
	if (cachedStartupThemes?.key === key) return cachedStartupThemes.themes;
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	const themes = loadThemes(resolvedPaths.themes);
	cachedStartupThemes = { key, themes };
	return themes;
}

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	requireInput("a startup question");
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	// The system theme starts in grayscale until the terminal reports its colors.
	markTerminalColorsPending();
	initTheme(
		resolveThemeSetting(settingsManager.getThemeSetting(), getTerminalTheme(), getTerminalColorMode()) ??
			SYSTEM_THEME_NAME,
	);
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	const themeSetting = settingsManager.getThemeSetting();
	queryStartupTerminalColors(ui, () => {
		setTheme(resolveThemeSetting(themeSetting, getTerminalTheme(), getTerminalColorMode()) ?? SYSTEM_THEME_NAME);
	});
}

/**
 * Query the terminal's colors without waiting for them. When they arrive, including after the timeout,
 * record them for the system theme and "" (terminal default) tokens, run `onColors`, and re-render.
 */
function queryStartupTerminalColors(ui: TUI, onColors: () => void): void {
	void requestTerminalColors(ui, (colors) => {
		setTerminalColors(colors);
		onColors();
		ui.invalidate();
		ui.requestRender();
	});
}

export async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * First-time setup runs when all of these hold:
 * - this is the official Octocode distribution (not a fork/rebrand)
 * - experimental features are enabled (OCTOCODE_EXPERIMENTAL=1)
 * - the default agent directory is used (no custom agent dir override)
 * - setup was not completed before (settings.json does not exist)
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (
		!isOfficialDistribution({
			packageName: PACKAGE_NAME,
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
		})
	) {
		return false;
	}
	if (!areExperimentalFeaturesEnabled()) {
		return false;
	}
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	return !existsSync(settingsPath);
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const handle = await acquireStartupTui(settingsManager);
	const { ui } = handle;
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await releaseStartupTui(handle);
			resolve(result);
		};

		const selector = new DialogSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		mountStartupTui(handle, settingsManager);
	});
}

/** Show the first-time setup dialog and persist the result */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const handle = await acquireStartupTui(settingsManager);
	const { ui } = handle;
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await releaseStartupTui(handle);
			resolve();
		};

		if (!handle.started) {
			ui.start();
			handle.started = true;
			if (handle.shared && sharedStartupTui?.ui === ui) sharedStartupTui.started = true;
		}
		let previewTheme = SYSTEM_THEME_NAME;
		setTheme(previewTheme);
		const component = new FirstTimeSetupComponent({
			onThemePreview: (themeName) => {
				previewTheme = themeName;
				setTheme(themeName);
				ui.requestRender();
			},
			onSubmit: (result) => void finish(result),
			onCancel: () => void finish(undefined),
		});
		ui.addChild(component);
		ui.setFocus(component);
		ui.requestRender();
		// The terminal's colors regenerate the system theme; re-rendering rebuilds the dialog with it.
		queryStartupTerminalColors(ui, () => setTheme(previewTheme));
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const handle = await acquireStartupTui(settingsManager);
	const { ui } = handle;
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await releaseStartupTui(handle);
			resolve(result);
		};

		const input = new DialogInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		mountStartupTui(handle, settingsManager);
	});
}
