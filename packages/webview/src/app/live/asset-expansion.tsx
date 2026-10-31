import type { ApplicationAsset } from "@octocodeai/octocode-contracts";
import { useState } from "react";
import { errorMessage } from "../model/format.ts";
import { Button } from "../ui/primitives.tsx";
import type { AssetLoader } from "./ContentBlocks.tsx";

/** Full message/tool payloads use the same schema validation as streamed content before entering a renderer. */
export function useAssetExpansion<T extends { full?: ApplicationAsset }>(
	asset: ApplicationAsset | undefined,
	loadAsset: AssetLoader,
	decode: (value: unknown, previous?: T) => T,
) {
	const key = asset && `${asset.id}:${asset.revision ?? ""}`;
	const [loaded, setLoaded] = useState<{ key: string; value: T }>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	return {
		available: asset !== undefined,
		value: loaded?.key === key ? loaded?.value : undefined,
		loading,
		error,
		async load() {
			if (!asset || !key) return;
			setLoading(true);
			setError("");
			try {
				const value = await expandAssetChain(asset, loadAsset, decode);
				setLoaded({ key, value });
			} catch (cause) {
				setError(errorMessage(cause));
			} finally {
				setLoading(false);
			}
		},
	};
}

/** The host may reference another bounded projection; never follow cyclic or unlimited chains. */
async function expandAssetChain<T extends { full?: ApplicationAsset }>(
	asset: ApplicationAsset,
	loadAsset: AssetLoader,
	decode: (value: unknown, previous?: T) => T,
): Promise<T> {
	const seen = new Set<string>();
	let current = asset;
	let result: T | undefined;
	for (let depth = 0; depth < 8; depth++) {
		if (seen.has(current.id)) throw new Error("Content reference cycle detected");
		seen.add(current.id);
		result = decode(JSON.parse(await (await loadAsset(current.id)).text()), result);
		if (!result.full) return result;
		current = result.full;
	}
	throw new Error("Content reference depth limit reached (8)");
}

export function AssetExpansionButton({
	expansion,
	label,
}: {
	expansion: { available: boolean; value?: unknown; loading: boolean; error: string; load: () => Promise<void> };
	label: string;
}) {
	return (
		<>
			{expansion.available && expansion.value === undefined && (
				<Button size="sm" loading={expansion.loading} onClick={expansion.load}>
					{label}
				</Button>
			)}
			{expansion.error && <p role="alert">{expansion.error}</p>}
		</>
	);
}
