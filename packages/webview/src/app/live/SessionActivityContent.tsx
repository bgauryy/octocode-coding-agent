import type { ApplicationActivity } from "@octocodeai/octocode-contracts";
import { Button } from "../ui/primitives.tsx";
import { type AssetLoader, useAssetRead } from "./asset-expansion.tsx";
import { ExpandedText, JsonDetails } from "./ContentBlocks.tsx";

/** Session notices share the same authenticated content reads as messages and tool results. */
export function SessionActivityContent({
	activity,
	text,
	loadAsset,
}: {
	activity: ApplicationActivity;
	text: string;
	loadAsset: AssetLoader;
}) {
	const { full } = activity;
	const json = full?.mimeType === "application/json";
	const read = useAssetRead<unknown>(json ? full : undefined);
	const current = read.loaded;
	const data = current ? current.value : activity.data;
	return (
		<>
			<ExpandedText text={text} full={json ? undefined : full} loadAsset={loadAsset} plain />
			{data !== undefined && <JsonDetails label="Details" value={data} />}
			{json && full && !current && (
				<Button
					size="sm"
					loading={read.loading}
					onClick={() => read.run(async (asset) => JSON.parse(await (await loadAsset(asset.id)).text()))}
				>
					Load full details
				</Button>
			)}
			{read.error && <p role="alert">{read.error}</p>}
		</>
	);
}
