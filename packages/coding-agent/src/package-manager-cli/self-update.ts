import { type MarkdownTheme, Markdown, stripRowMarks } from "@octocodeai/octocode-tui";
import { cliStyle } from "../utils/cli-style.ts";
import {
	APP_NAME,
	getPackageDir,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	type SelfUpdatePackageTarget,
	VERSION,
} from "../config.ts";
import { spawnProcess } from "@octocodeai/octocode-common/child-process";
import { formatVersionCheckError, getLatestOctocodeRelease, isNewerPackageVersion } from "../utils/version-check.ts";
import { isOfflineModeEnabled } from "../utils/env-flag.ts";
import {
	cleanupWindowsSelfUpdateQuarantine,
	quarantineWindowsNativeDependencies,
} from "../utils/windows-self-update.ts";

const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => cliStyle.heading(cliStyle.warn(text)),
	link: (text) => cliStyle.link(text),
	linkUrl: (text) => cliStyle.dim(text),
	code: (text) => cliStyle.warn(text),
	codeBlock: (text) => cliStyle.dim(text),
	codeBlockBorder: (text) => cliStyle.dim(text),
	quote: (text) => cliStyle.dim(text),
	quoteBorder: (text) => cliStyle.dim(text),
	hr: (text) => cliStyle.dim(text),
	listBullet: (text) => cliStyle.warn(text),
	bold: (text) => cliStyle.heading(text),
	italic: (text) => cliStyle.italic(text),
	strikethrough: (text) => cliStyle.strikethrough(text),
	underline: (text) => cliStyle.underline(text),
};

export function printSelfUpdateUnavailable(
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = PACKAGE_NAME,
): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageTarget));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of ${APP_NAME} executable: ${entrypoint}`);
	}
}

export function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(cliStyle.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

export function printPnpmSelfUpdateMetadataHint(): void {
	console.error(cliStyle.warn("If pnpm reports missing package versions, its cached registry metadata may be stale."));
	console.error(cliStyle.warn(`Run \`pnpm store prune\` and retry \`${APP_NAME} update --self\`.`));
}

export function printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(cliStyle.heading(cliStyle.warn("Update note")));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		// Printed straight to stdout, not through the TUI: drop the row marks the renderer would strip.
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.map((line) => stripRowMarks(line).trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		console.log(trimmedNote);
	}
	console.log();
}

interface SelfUpdatePlan {
	packageName: string;
	installSpec: string;
	version: string;
	shouldRun: boolean;
	note?: string;
}

export async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	// The version check is network work offline mode skips; say so instead of "could not determine".
	if (isOfflineModeEnabled())
		throw new Error(
			`Offline mode is on (--offline or OCTOCODE_OFFLINE), so ${APP_NAME} cannot check for a newer version. Run update without it.`,
		);
	let latestRelease: Awaited<ReturnType<typeof getLatestOctocodeRelease>>;
	try {
		latestRelease = await getLatestOctocodeRelease(VERSION, { retry: true });
	} catch (error: unknown) {
		throw new Error(`Could not determine latest ${APP_NAME} version: ${formatVersionCheckError(error)}`, {
			cause: error,
		});
	}
	if (!latestRelease) {
		throw new Error(`Could not determine latest ${APP_NAME} version.`);
	}

	const packageName = latestRelease.packageName ?? PACKAGE_NAME;
	const installSpec = `${packageName}@${latestRelease.version}`;
	if (force || packageName !== PACKAGE_NAME || isNewerPackageVersion(latestRelease.version, VERSION)) {
		return {
			packageName,
			installSpec,
			version: latestRelease.version,
			...(latestRelease.note ? { note: latestRelease.note } : {}),
			shouldRun: true,
		};
	}

	console.log(cliStyle.success(`${APP_NAME} is already up to date (v${VERSION})`));
	return { packageName, installSpec, version: latestRelease.version, shouldRun: false };
}

export async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(cliStyle.dim(`Updating ${APP_NAME} with ${command.display}...`));
	for (const step of command.steps ?? [command]) {
		await new Promise<void>((resolve, reject) => {
			const child = spawnProcess(step.command, step.args, {
				stdio: "inherit",
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

export function prepareWindowsNpmSelfUpdate(): void {
	if (process.platform !== "win32") {
		return;
	}

	const packageDir = getPackageDir();
	cleanupWindowsSelfUpdateQuarantine(packageDir);
	quarantineWindowsNativeDependencies(packageDir);
}
