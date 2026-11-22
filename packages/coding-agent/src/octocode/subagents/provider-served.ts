import { requestVendorModels, MODEL_DISCOVERY_SOURCES } from "@octocodeai/octocode-ai/providers/discovery";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { closestIds } from "../../configuration/result.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";

type ListOptions = NonNullable<Parameters<typeof requestVendorModels>[2]>;
type ListSource = NonNullable<ListOptions["source"]>;

/** What a host's own model list said about the ids configured for it. */
export type ServedReport =
	| { kind: "listed"; served: number; unserved: { id: string; suggestions: string[] }[]; servedSample: string[] }
	| { kind: "failed"; message: string };

/** The most unserved ids one report names; a catalog far from the host's list would otherwise fill the page. */
const MAX_UNSERVED = 50;
const SUGGESTIONS = 3;
const SAMPLE = 5;

type Listing = Pick<ModelRuntime, "getProvider" | "getAuth" | "getModels">;

/**
 * The list route to ask: the registry's documented one for a built-in provider (none when it only has a catalog or
 * documentation), else the standard one for the API a custom provider speaks. Undefined when nothing is known to list.
 */
function listSource(runtime: Pick<Listing, "getModels">, providerId: string): ListSource | undefined {
	const known = MODEL_DISCOVERY_SOURCES[providerId];
	if (known) return known.path ? known : undefined;
	const api = runtime.getModels(providerId)[0]?.api;
	if (api === "openai-completions" || api === "openai-responses") return { path: "models", format: "openai", docs: "" };
	if (api === "anthropic-messages") return { path: "v1/models", format: "anthropic", docs: "" };
	return undefined;
}

/**
 * Asks the provider's host which models it serves (the free list route, never an inference request) and compares them
 * with the model ids configured for the provider; each unserved id comes with the served ids nearest to it. Undefined
 * when the provider has no list route here. A failed list is reported with its HTTP status, never a body or a key.
 */
export async function servedModelReport(
	runtime: Listing,
	providerId: string,
	options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<ServedReport | undefined> {
	const source = listSource(runtime, providerId);
	const provider = runtime.getProvider(providerId);
	if (!source || !provider) return undefined;
	try {
		const resolved = source.public
			? { auth: {}, source: "public" }
			: await runtime.getAuth(providerId, { signal: options.signal });
		if (!resolved) return undefined;
		const listed = await requestVendorModels(provider, resolved.auth, {
			signal: options.signal,
			fetch: options.fetch,
			source,
			chatGPT: providerId === "openai" && resolved.source === "OAuth",
		});
		const served = listed.map((model) => model.id);
		const have = new Set(served);
		const unserved = [...new Set(runtime.getModels(providerId).map((model) => model.id))]
			.filter((id) => !have.has(id))
			.slice(0, MAX_UNSERVED)
			.map((id) => ({ id, suggestions: closestIds(id, served, SUGGESTIONS) }));
		return { kind: "listed", served: served.length, unserved, servedSample: served.slice(0, SAMPLE) };
	} catch (error) {
		options.signal?.throwIfAborted();
		return { kind: "failed", message: errorMessage(error) };
	}
}

/** The line a result adds for ids the host does not serve; empty when every configured id is served. */
export function describeUnserved(report: Extract<ServedReport, { kind: "listed" }>): string {
	if (report.unserved.length === 0) return "";
	const lines = report.unserved.map(({ id, suggestions }) =>
		suggestions.length > 0 ? `${id} (nearest served: ${suggestions.join(", ")})` : id,
	);
	const sample = report.unserved.every((entry) => entry.suggestions.length === 0) && report.servedSample.length > 0;
	return `not served by the host: ${lines.join("; ")}${sample ? `. It serves, for example: ${report.servedSample.join(", ")}` : ""}`;
}
