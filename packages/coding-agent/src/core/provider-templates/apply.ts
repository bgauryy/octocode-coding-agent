import { normalizeEndpointHost } from "@octocodeai/octocode-ai";
import { urlCredentialProblem } from "@octocodeai/octocode-common/url-credentials";
import type { ModelsJsonModel, ModelsJsonProvider } from "../model-config.ts";
import { NO_KEY } from "../models-json-keys.ts";
import { rewriteProviders } from "./models-file.ts";
import type { ProviderTemplate } from "./templates.ts";

/**
 * The `apiKey` of a local server that runs without a key: the request needs some value and the server ignores it. It
 * is a marker, not a secret.
 */

/**
 * How the provider gets its key: a `!` reference to a keychain entry (the default), plain text in auth.json through
 * `/providers` (an explicit choice), a `$NAME` reference, or none (local).
 */
export type TemplateKey =
	| { kind: "keychain"; reference: string }
	| { kind: "saved" }
	| { kind: "env"; name: string }
	| { kind: "none" };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** The template's fixed host, or the host the user gave: an https URL (http for localhost) without credentials or a trailing slash. */
export function templateBaseUrl(template: ProviderTemplate, host?: string): string {
	const given = template.baseUrl ?? (host?.trim() || (template.hostDefault ? template.hostHint : undefined));
	if (!given) throw new Error(`${template.name} needs the host of your server, for example ${template.hostHint}.`);
	let url: URL;
	try {
		url = new URL(given);
	} catch {
		throw new Error(`Not a valid URL. Give the full address, for example ${template.hostHint}.`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new Error("The host must start with http:// or https://.");
	const problem = urlCredentialProblem(given);
	if (problem) throw new Error(`The host must not carry a key (${problem}); the key is asked for next.`);
	// A host the user typed takes the same rule as every other custom host: https, or http for localhost only.
	return template.baseUrl ? given.replace(/\/+$/, "") : normalizeEndpointHost(given);
}

/** The `models.json` provider entry for a template. Never holds a key: only a `!` or `$NAME` reference or the local marker. */
export function templateProviderEntry(
	template: ProviderTemplate,
	options: { host?: string; key: TemplateKey; models: readonly ModelsJsonModel[] },
): ModelsJsonProvider {
	if (options.models.length === 0) throw new Error("Choose at least one model id.");
	const { key } = options;
	if (key.kind === "env" && !ENV_NAME.test(key.name)) throw new Error(`Not an environment variable name: ${key.name}`);
	if (key.kind === "none" && template.key !== "optional") throw new Error(`${template.name} needs an API key.`);
	if (key.kind === "keychain" && !key.reference.startsWith("!"))
		throw new Error("A keychain key is written as a keychain reference (starting with !), never as the key.");
	const apiKey =
		key.kind === "env"
			? `$${key.name}`
			: key.kind === "none"
				? NO_KEY
				: key.kind === "keychain"
					? key.reference
					: undefined;
	return {
		name: template.name,
		baseUrl: templateBaseUrl(template, options.host),
		api: template.api,
		...(apiKey ? { apiKey } : {}),
		...(template.compat ? { compat: { ...template.compat } } : {}),
		models: options.models.map((model): ModelsJsonModel => ({
			// A local alias must not inherit another host's prices, input types or reasoning claims from its model id.
			...(template.kind === "local"
				? { reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
				: {}),
			...model,
		})),
	};
}

/** The first of `base`, `base-2`, `base-3`, ... that is not in `taken`. */
export function freeProviderId(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Add one provider to the global `models.json`: the rest of the file is kept, an existing provider id is refused, the
 * write is atomic (and fails when the file changed meanwhile) and the file is private (0600). A file with comments is
 * left alone, since rewriting it would drop them: the error carries the entry to paste.
 */
export async function addTemplateProvider(file: string, id: string, entry: ModelsJsonProvider): Promise<void> {
	if (!PROVIDER_ID.test(id)) throw new Error(`Not a provider id: ${id} (lower-case letters, digits, ".", "_", "-").`);
	const snippet = JSON.stringify({ [id]: entry }, null, "\t");
	await rewriteProviders(
		file,
		(providers) => {
			if (Object.hasOwn(providers, id)) {
				throw new Error(`${file} already defines the provider "${id}"; it was not changed. Choose another id.`);
			}
			return { ...providers, [id]: entry };
		},
		`Add this under "providers":\n${snippet}`,
	);
}
