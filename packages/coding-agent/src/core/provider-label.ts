import type { ModelRuntime } from "./model-runtime.ts";

/** A credential's public method name, never its value. Cloud profiles and tokens need their own labels. */
export function providerAccessLabel(
	runtime: Pick<ModelRuntime, "getProviderKind" | "getProvider">,
	id: string,
): string {
	const kind = runtime.getProviderKind(id);
	return kind === "API key" ? (runtime.getProvider(id)?.auth.apiKey?.name ?? kind) : kind;
}
