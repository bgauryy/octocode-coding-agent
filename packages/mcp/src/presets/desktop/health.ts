import { spawnSync } from "node:child_process";

/**
 * The oldest Cua Driver the `desktop` preset was recorded against (the `fixtures/desktop/tools.json` fixture holds the
 * recorded tool list, and the preset test checks the preset's lists against it). An older Driver may lack tools or
 * arguments the specialist's prompt names; a newer one is expected to work.
 */
export const MIN_DRIVER_VERSION = "0.30.4";

/** What runs `cua-driver <args>`: stdout and the exit status, or undefined when it could not start. Injected by tests. */
export type DriverRunner = (command: string, args: string[]) => { stdout: string; status: number | null } | undefined;

const run: DriverRunner = (command, args) => {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 3000 });
	return result.error ? undefined : { stdout: result.stdout ?? "", status: result.status };
};

/** `1.2.3` parsed to numbers, or undefined for text with no version in it. */
function parse(text: string): number[] | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. */
export function compareVersions(a: string, b: string): number {
	const left = parse(a);
	const right = parse(b);
	if (!left || !right) return 0;
	for (let index = 0; index < 3; index++)
		if (left[index] !== right[index]) return (left[index] ?? 0) - (right[index] ?? 0);
	return 0;
}

/** The version printed by the selected executable, when its probe succeeds. */
export function driverVersion(command: string, runner: DriverRunner = run): string | undefined {
	const answer = runner(command, ["--version"]);
	return answer?.status === 0 ? /(\d+\.\d+\.\d+\S*)/.exec(answer.stdout)?.[1] : undefined;
}

/** One line for the `/mcp` row when the Driver is older than the recorded floor, else undefined (an unknown version says nothing). */
export function versionNotice(version: string | undefined): string | undefined {
	return version && compareVersions(version, MIN_DRIVER_VERSION) < 0
		? `Cua Driver ${version} is older than ${MIN_DRIVER_VERSION}, the oldest this was recorded against: some desktop tools or arguments may be missing (cua-driver update)`
		: undefined;
}

/**
 * Warnings about a Driver that is installed but cannot do its job, for the user, never the model. macOS only: a missing
 * Accessibility or Screen Recording grant (the platform's own `permissions status` answers, read-only), which is why a
 * first call otherwise fails with a closed connection. No daemon is not a warning: the MCP process starts one on first use,
 * and without one the answer is `unknown`, which says nothing.
 */
export function healthWarnings(
	command: string,
	platform: NodeJS.Platform = process.platform,
	runner: DriverRunner = run,
): string[] {
	if (platform !== "darwin") return [];
	const answer = runner(command, ["permissions", "status", "--json"]);
	if (!answer || answer.status !== 0) return [];
	let status: { accessibility?: unknown; screen_recording?: unknown };
	try {
		status = JSON.parse(answer.stdout) as typeof status;
	} catch {
		return [];
	}
	const missing = [
		...(status.accessibility === false ? ["Accessibility"] : []),
		...(status.screen_recording === false ? ["Screen Recording"] : []),
	];
	return missing.length === 0
		? []
		: [
				`Cua Driver has no ${missing.join(" or ")} permission, so desktop control will fail: run \`cua-driver permissions grant\` and approve the dialogs.`,
			];
}

const probes = new Map<string, { attempts: number; next: number }>();
const RETRY_DELAY_MS = 60_000;
const MAX_VERSION_ATTEMPTS = 3;

/** Each executable announces its warnings once. An inconclusive version can be retried on a later warning drain. */
export function takeDriverWarnings(command: string, runner: DriverRunner = run, now = Date.now()): string[] {
	const previous = probes.get(command);
	if (previous && now < previous.next) return [];
	const version = driverVersion(command, runner);
	const attempts = (previous?.attempts ?? 0) + 1;
	const next = version || attempts >= MAX_VERSION_ATTEMPTS ? Infinity : now + RETRY_DELAY_MS * attempts;
	probes.set(command, { attempts, next });
	const notice = versionNotice(version);
	return [...(notice ? [notice] : []), ...(previous ? [] : healthWarnings(command, process.platform, runner))];
}
