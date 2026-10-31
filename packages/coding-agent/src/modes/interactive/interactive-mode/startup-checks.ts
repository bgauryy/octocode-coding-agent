/**
 * Checks and notices around startup: package updates, the tmux keyboard setup, the changelog, install telemetry, and
 * the new-version and package-update notifications.
 */

import {
	getCapabilities,
	hasTmuxSession,
	hyperlink,
	Markdown,
	Spacer,
	tmuxGlobalOption,
	Text,
} from "@octocodeai/octocode-tui";
import { APP_NAME, getAgentDir, VERSION } from "../../../config.ts";
import { DefaultPackageManager } from "../../../core/package-manager.ts";
import { isInstallTelemetryEnabled } from "../../../core/telemetry.ts";
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../../utils/changelog.ts";
import { getOctocodeUserAgent } from "../../../utils/user-agent.ts";
import type { LatestOctocodeRelease } from "../../../utils/version-check.ts";
import { DynamicBorder } from "../components/dynamic-border.ts";
import { ThemedText } from "../components/themed-text.ts";
import { theme } from "../../../theme/theme.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the startup checks and notices. */
type StartupChecksHost = Pick<
	InteractiveModeHost,
	| "changelogMarkdown"
	| "chatContainer"
	| "getMarkdownThemeWithSettings"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "startupNoticesShown"
	| "ui"
	| "version"
>;

export async function checkForPackageUpdates(host: StartupChecksHost): Promise<string[]> {
	if (process.env.OCTOCODE_OFFLINE) {
		return [];
	}

	try {
		const packageManager = new DefaultPackageManager({
			cwd: host.sessionManager.getCwd(),
			agentDir: getAgentDir(),
			settingsManager: host.settingsManager,
		});
		const updates = await packageManager.checkForAvailableUpdates();
		return updates.map((update) => update.displayName);
	} catch {
		return [];
	}
}

export async function checkTmuxKeyboardSetup(): Promise<string | undefined> {
	if (!hasTmuxSession()) return undefined;

	const extendedKeys = await tmuxGlobalOption("extended-keys");

	// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
	if (extendedKeys === undefined) return undefined;

	if (extendedKeys !== "on" && extendedKeys !== "always") {
		return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
	}

	return undefined;
}

/**
 * Get changelog entries to display on startup.
 * Only shows new entries since last seen version, skips for resumed sessions.
 */
export function getChangelogForDisplay(host: StartupChecksHost): string | undefined {
	// Skip changelog for resumed/continued sessions (already have messages)
	if (host.session.state.messages.length > 0) {
		return undefined;
	}

	const lastVersion = host.settingsManager.getLastChangelogVersion();
	const changelogPath = getChangelogPath();
	const entries = parseChangelog(changelogPath);

	if (!lastVersion) {
		// Fresh install - record the version, send telemetry, don't show changelog
		host.settingsManager.setLastChangelogVersion(VERSION);
		reportInstallTelemetry(host, VERSION);
		return undefined;
	}

	const newEntries = getNewEntries(entries, lastVersion);
	if (newEntries.length > 0) {
		host.settingsManager.setLastChangelogVersion(VERSION);
		reportInstallTelemetry(host, VERSION);
		return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
	}

	return undefined;
}

function reportInstallTelemetry(host: StartupChecksHost, version: string): void {
	if (process.env.OCTOCODE_OFFLINE) {
		return;
	}

	if (!isInstallTelemetryEnabled(host.settingsManager)) {
		return;
	}

	const endpoint = process.env.OCTOCODE_INSTALL_TELEMETRY_URL;
	if (!endpoint) return;
	let url: URL;
	try {
		url = new URL(endpoint);
		url.searchParams.set("version", version);
	} catch {
		return;
	}
	void fetch(url, {
		headers: {
			"User-Agent": getOctocodeUserAgent(version),
		},
		signal: AbortSignal.timeout(5000),
	})
		.then(() => undefined)
		.catch(() => undefined);
}

export function showStartupNoticesIfNeeded(host: StartupChecksHost): void {
	if (host.startupNoticesShown) {
		return;
	}
	host.startupNoticesShown = true;

	if (!host.changelogMarkdown) {
		return;
	}

	if (host.chatContainer.children.length > 0) {
		host.chatContainer.addChild(new Spacer(1));
	}
	host.chatContainer.addChild(new DynamicBorder());
	if (host.settingsManager.getCollapseChangelog()) {
		const versionMatch = host.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
		const latestVersion = versionMatch ? versionMatch[1] : host.version;
		const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
		host.chatContainer.addChild(new Text(condensedText, 1, 0));
	} else {
		host.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "What's New")), 1, 0));
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(new Markdown(host.changelogMarkdown.trim(), 1, 0, host.getMarkdownThemeWithSettings()));
		host.chatContainer.addChild(new Spacer(1));
	}
	host.chatContainer.addChild(new DynamicBorder());
}

export function showNewVersionNotification(host: StartupChecksHost, release: LatestOctocodeRelease): void {
	const updateInstruction = () =>
		theme.fg("muted", `New version ${release.version} is available. Run `) + theme.fg("accent", `${APP_NAME} update`);
	const changelogUrl = "https://github.com/bgauryy/octocodecode/releases";
	const changelogLine = () => {
		const changelogLink = getCapabilities().hyperlinks
			? hyperlink(theme.fg("accent", changelogUrl), changelogUrl)
			: theme.fg("accent", changelogUrl);
		return theme.fg("muted", "Changelog: ") + changelogLink;
	};
	const note = release.note?.trim();

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	host.chatContainer.addChild(
		new ThemedText(() => `${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction()}`, 1, 0),
	);
	if (note) {
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(
			new Markdown(note, 1, 0, host.getMarkdownThemeWithSettings(), {
				color: (text) => theme.fg("muted", text),
			}),
		);
		host.chatContainer.addChild(new Spacer(1));
	}
	host.chatContainer.addChild(new ThemedText(changelogLine, 1, 0));
	host.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	host.ui.requestRender();
}

export function showPackageUpdateNotification(host: StartupChecksHost, packages: string[]): void {
	const updateInstruction = () =>
		theme.fg("muted", "Package updates are available. Run ") + theme.fg("accent", `${APP_NAME} update --extensions`);
	const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	host.chatContainer.addChild(
		new ThemedText(
			() =>
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction()}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
			1,
			0,
		),
	);
	host.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
	host.ui.requestRender();
}
