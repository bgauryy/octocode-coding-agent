import type * as NodeOs from "node:os";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// Keep runtime OS loading browser-safe. A top-level runtime import of node:os breaks browser/Vite builds.
const nodeOs = loadNodeOs();

let appVersion: string | undefined;

/**
 * The version every provider request names after `octocode/`. The host sets it once at startup from its package
 * version; until then requests say `octocode` without one.
 */
export function setUserAgentVersion(version: string | undefined): void {
	appVersion = version?.trim() || undefined;
}

/** The User-Agent of every provider request: `octocode/<version> (<os> <release>; <arch>)`. */
export function getUserAgent(): string {
	const product = appVersion ? `octocode/${appVersion}` : "octocode";
	return nodeOs ? `${product} (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : `${product} (browser)`;
}
