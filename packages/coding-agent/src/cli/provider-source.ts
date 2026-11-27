import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import type { ModelRuntime } from "../core/model-runtime.ts";

type SourceRuntime = Pick<ModelRuntime, "getProviderDefinitionFile" | "getModelsDiagnostics">;

/** Where a provider is defined: a models.json with its scope and product, or the built-in catalog. */
export interface ProviderSource {
	file?: string;
	scope?: "global" | "workspace";
	product?: "Octocode" | "Pi";
}

export function providerSource(runtime: SourceRuntime, providerId: string): ProviderSource {
	const file = runtime.getProviderDefinitionFile(providerId);
	if (!file) return {};
	const { scope, product } = runtime.getModelsDiagnostics().describeFile(file);
	return { file, scope, product };
}

/** The `source` cell: `~/.octocode/models.json (global, Octocode)`, or `built-in`. */
export function providerSourceLabel(source: ProviderSource): string {
	return source.file ? `${homeTilde(source.file)} (${source.scope}, ${source.product})` : "built-in";
}
