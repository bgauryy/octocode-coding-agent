import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { CONFIG_DIR_NAME } from "../../config.ts";

/**
 * The project whose models.json files a session may read: its folder and whether the user trusts it. Trust is asked on
 * every load, so a trust change takes effect on the next reload, with no new runtime.
 */
export interface ModelsProject {
	cwd: string;
	isTrusted(): boolean;
}

/** The project models.json files in precedence order: Octocode's, then Pi's (only with Pi compatibility on). */
export function projectModelsPaths(cwd: string, piEnabled: boolean): string[] {
	return [join(cwd, CONFIG_DIR_NAME, "models.json"), ...(piEnabled ? [join(cwd, ".pi", "models.json")] : [])];
}

/** The warning for a project models.json that exists but was not read because the folder is not trusted. */
export function untrustedProjectModelsWarning(path: string, cwd: string): string {
	return `Project models.json not loaded because the folder is not trusted: ${path}. It can define providers and their hosts, so it loads only for a trusted folder: run \`octocode trust add ${cwd}\`, then start a new session (trust is fixed for a running session).`;
}

function hostOf(baseUrl: string | undefined): string {
	if (!baseUrl) return "the built-in host";
	try {
		return new URL(baseUrl).host || "an unparseable host";
	} catch {
		return "an unparseable host";
	}
}

/** Where a models.json file sits: its folder scope and whose product it belongs to (Pi's folders end in `.pi`). */
export interface ModelsFileSource {
	file: string;
	scope: "global" | "workspace";
	product: "Octocode" | "Pi";
}

function describeModelsFile(file: string, cwd: string): ModelsFileSource {
	const absolute = resolve(file);
	return {
		file,
		scope: projectModelsPaths(cwd, true).some((path) => resolve(path) === absolute) ? "workspace" : "global",
		product: absolute.split(sep).includes(".pi") ? "Pi" : "Octocode",
	};
}

/** A models.json file that is not read, and the folder whose trust would load it. */
export interface UntrustedModelsFile {
	path: string;
	cwd: string;
}

/** One provider definition that another file's definition of the same id replaced. */
export interface ShadowedDefinition {
	provider: string;
	file: string;
	shadowedBy: string;
}

/**
 * Whether an untrusted project file names the provider (and, with `modelId`, that model): the hint that says trust is
 * what is missing. Only ids are read from the file, as JSON; nothing in it is run.
 */
function untrustedDefinitionHint(
	files: readonly UntrustedModelsFile[],
	providerId: string | undefined,
	modelId?: string,
): string | undefined {
	for (const { path, cwd } of files) {
		let providers: unknown;
		try {
			providers = (JSON.parse(readFileSync(path, "utf-8")) as { providers?: unknown }).providers;
		} catch {
			continue; // unreadable or invalid: the load already says so when trusted
		}
		if (!isRecord(providers)) continue;
		const entries = providerId ? [[providerId, providers[providerId]] as const] : Object.entries(providers);
		for (const [id, entry] of entries) {
			if (!isRecord(entry)) continue;
			const models = Array.isArray(entry.models) ? entry.models : [];
			const hasModel = (wanted: string) => models.some((model) => isRecord(model) && model.id === wanted);
			if (modelId !== undefined && !hasModel(modelId)) continue;
			const what = modelId === undefined ? `provider "${id}"` : `model "${modelId}" of provider "${id}"`;
			return `The ${what} is defined in ${path}, which is not loaded because the folder is not trusted. Run \`octocode trust add ${cwd}\`, then start a new session.`;
		}
	}
	return undefined;
}

/**
 * One definition replaced another provider's of the same id (project over global, Octocode over Pi, or any other pair).
 * A stored key for that id goes to the winner's host, so the host is named when it differs. Hosts only: never a key.
 */
function providerShadowWarning(
	providerId: string,
	winnerFile: string,
	shadowedFile: string,
	winnerBaseUrl: string | undefined,
	shadowedBaseUrl: string | undefined,
): string {
	const hosts =
		hostOf(winnerBaseUrl) === hostOf(shadowedBaseUrl)
			? ""
			: ` Requests now go to ${hostOf(winnerBaseUrl)} instead of ${hostOf(shadowedBaseUrl)}.`;
	return `models.json provider "${providerId}" in ${winnerFile} merges over the one in ${shadowedFile}: the fields it sets win, the rest are kept.${hosts}`;
}

/**
 * A trusted project file replaced a provider the global files also define. A stored key for that id goes to the
 * project's host, so the host is named when it differs. Hosts only: never a key or URL path.
 */
function projectShadowWarning(
	providerId: string,
	projectFile: string,
	shadowedFile: string,
	projectBaseUrl: string | undefined,
	shadowedBaseUrl: string | undefined,
): string {
	const hosts =
		hostOf(projectBaseUrl) === hostOf(shadowedBaseUrl)
			? ""
			: ` Requests now go to ${hostOf(projectBaseUrl)} instead of ${hostOf(shadowedBaseUrl)}.`;
	return `Project models.json provider "${providerId}" (${projectFile}) merges over the one in ${shadowedFile}: the fields it sets win, the rest are kept.${hosts}`;
}

/** What one models.json load learned beyond its providers: overrides, untrusted files not read, and where files sit. */
export class ModelsDiagnostics {
	private readonly shadowed: ShadowedDefinition[] = [];
	private readonly untrusted: UntrustedModelsFile[] = [];
	private readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	noteUntrusted(path: string, cwd: string): void {
		this.untrusted.push({ path, cwd });
	}

	/** Records an override and returns its warning: the project wording when a project file replaced a global one. */
	noteShadow(
		provider: string,
		winner: { file: string; baseUrl?: string; project: boolean },
		loser: { file: string; baseUrl?: string; project: boolean },
	): string {
		this.shadowed.push({ provider, file: loser.file, shadowedBy: winner.file });
		const warn = winner.project && !loser.project ? projectShadowWarning : providerShadowWarning;
		return warn(provider, winner.file, loser.file, winner.baseUrl, loser.baseUrl);
	}

	/** The file's folder scope and product, relative to the folder this load ran in. */
	describeFile(file: string): ModelsFileSource {
		return describeModelsFile(file, this.cwd);
	}

	/** The definitions that lost to another file's definition of the same provider id. */
	getShadowedDefinitions(): readonly ShadowedDefinition[] {
		return this.shadowed;
	}

	/** Says to trust the folder when an untrusted project models.json defines the provider (or the model). */
	untrustedHint(providerId: string | undefined, modelId?: string): string | undefined {
		return untrustedDefinitionHint(this.untrusted, providerId, modelId);
	}
}
