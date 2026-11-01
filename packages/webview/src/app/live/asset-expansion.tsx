import type { ApplicationAsset } from "@octocodeai/octocode-contracts";
import { useState } from "react";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Button } from "../ui/primitives.tsx";

export type AssetLoader = (id: string, signal?: AbortSignal) => Promise<Blob>;

/** Full message/tool payloads use the same schema validation as streamed content before entering a renderer. */
export function useAssetExpansion<T extends { full?: ApplicationAsset }>(
	asset: ApplicationAsset | undefined,
	loadAsset: AssetLoader,
	decode: (value: unknown, previous?: T) => T,
) {
	const read = useAssetRead<T>(asset);
	return {
		available: asset !== undefined,
		value: read.loaded?.value,
		loading: read.loading,
		error: read.error,
		load: () => read.run((current) => expandAssetChain(current, loadAsset, decode)),
	};
}

/**
 * The result, progress and failure of reading one asset revision. Each is kept with the revision it belongs to, so
 * when the asset changes the view shows that revision's state, not a previous revision's result or error.
 */
export function useAssetRead<T>(asset: ApplicationAsset | undefined) {
	const key = asset && `${asset.id}:${asset.revision ?? ""}`;
	const [loaded, setLoaded] = useState<{ key: string; value: T }>();
	const [pending, setPending] = useState<string>();
	const [failure, setFailure] = useState<{ key: string; message: string }>();
	return {
		loaded: loaded?.key === key ? loaded : undefined,
		loading: key !== undefined && pending === key,
		error: failure && failure.key === key ? failure.message : "",
		async run(read: (asset: ApplicationAsset) => Promise<T>) {
			if (!asset || !key) return;
			setPending(key);
			setFailure(undefined);
			try {
				setLoaded({ key, value: await read(asset) });
			} catch (cause) {
				setFailure({ key, message: errorMessage(cause) });
			} finally {
				setPending((current) => (current === key ? undefined : current));
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
