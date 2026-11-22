import { refuseRealProviderFile } from "../../storage/state-paths.ts";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Compile } from "typebox/compile";
import { atomicWriteFile, sha256 } from "@octocodeai/octocode-common/atomic-file";
import { hasJsonComments, stripJsonComments } from "@octocodeai/octocode-common/json";
import { stripBom } from "@octocodeai/octocode-common/text";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { ModelConfig, type ModelsJsonModel, type ModelsJsonProvider, ModelsConfigSchema } from "../model-config.ts";

const validateModelsConfig = Compile(ModelsConfigSchema);

/**
 * Change the `providers` of a models.json: the rest of the file is kept, the write is atomic (and fails when the
 * file changed meanwhile) and the file is private (0600). A file with comments is left alone, since rewriting it
 * would drop them: the error carries `snippet` to paste instead.
 */
export async function rewriteProviders(
	file: string,
	change: (providers: Record<string, unknown>) => Record<string, unknown>,
	snippet: string,
): Promise<void> {
	refuseRealProviderFile(file);
	let text: string | undefined;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (text !== undefined && hasJsonComments(text)) {
		throw new Error(`${file} has comments, which a rewrite would drop. Change it by hand:\n${snippet}`);
	}
	let config: Record<string, unknown> = { providers: {} };
	if (text !== undefined && stripBom(text).trim()) {
		try {
			config = JSON.parse(stripJsonComments(stripBom(text))) as Record<string, unknown>;
		} catch {
			throw new Error(`${file} is not valid JSON; fix it first, then try again.`);
		}
		if (!isRecord(config)) throw new Error(`${file} must hold a JSON object.`);
	}
	const providers = config.providers ?? {};
	if (!isRecord(providers)) throw new Error(`${file}: "providers" must be an object.`);
	const next = { ...config, providers: change(providers) };
	if (!validateModelsConfig.Check(next)) throw new Error(`The change does not fit models.json:\n${snippet}`);
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	await atomicWriteFile(file, `${JSON.stringify(next, null, "\t")}\n`, text === undefined ? null : sha256(text), {
		mode: 0o600,
	});
}

function requireProvider(file: string, providers: Record<string, unknown>, id: string): ModelsJsonProvider {
	const current = providers[id];
	if (!Object.hasOwn(providers, id) || !isRecord(current))
		throw new Error(`${file} does not define the provider "${id}".`);
	return current;
}

/**
 * Remove one custom provider from models.json; the other providers are kept. Returns the `apiKey` value the entry
 * held (a reference or the local marker, never printed), so the caller can remove what it points at.
 */
export async function removeModelsProvider(file: string, id: string): Promise<string | undefined> {
	let apiKey: string | undefined;
	await rewriteProviders(
		file,
		(providers) => {
			const removed = requireProvider(file, providers, id);
			apiKey = typeof removed.apiKey === "string" ? removed.apiKey : undefined;
			const { [id]: _removed, ...rest } = providers;
			return rest;
		},
		`Delete "${id}" from "providers".`,
	);
	return apiKey;
}

/** What `/providers` can change on a custom provider: its host and its models' limits. Never its key. */
export interface ModelsProviderEdit {
	baseUrl?: string;
	/** Per model id: the context window and maximum output to set. */
	limits?: Readonly<Record<string, { contextWindow: number; maxTokens: number }>>;
}

/** Apply an edit to one custom provider of models.json; its other fields and the other providers are kept. */
export async function editModelsProvider(file: string, id: string, edit: ModelsProviderEdit): Promise<void> {
	await rewriteProviders(
		file,
		(providers) => {
			const current = requireProvider(file, providers, id);
			const models = current.models?.map((model: ModelsJsonModel) => {
				const limits = edit.limits?.[model.id];
				return limits ? { ...model, ...limits } : model;
			});
			return {
				...providers,
				[id]: { ...current, ...(edit.baseUrl ? { baseUrl: edit.baseUrl } : {}), ...(models ? { models } : {}) },
			};
		},
		`Edit "${id}" under "providers": ${JSON.stringify(edit)}`,
	);
}

/** The `apiKey` of one provider of models.json, or undefined when it sets none. The value is a secret: never print it. */
export async function readModelsProviderKey(file: string, id: string): Promise<string | undefined> {
	const config = await ModelConfig.loadFile(file);
	if (config.isUnreadable()) throw new Error(`${file} cannot be read; fix it first, then try again.`);
	const apiKey = config.getProvider(id)?.apiKey;
	return typeof apiKey === "string" ? apiKey : undefined;
}

/**
 * Replace the `apiKey` of one provider with `reference` (a keychain `!command`). Fails, writing nothing, when the
 * entry no longer holds `expected`, so a key edited meanwhile is never overwritten. The rest of the file is kept.
 */
export async function replaceModelsProviderKey(
	file: string,
	id: string,
	expected: string,
	reference: string,
): Promise<void> {
	await rewriteProviders(
		file,
		(providers) => {
			const current = requireProvider(file, providers, id);
			if (current.apiKey !== expected) throw new Error(`The key of "${id}" in ${file} changed; try again.`);
			return { ...providers, [id]: { ...current, apiKey: reference } };
		},
		`Set "apiKey" of "${id}" under "providers" to the keychain reference.`,
	);
}
