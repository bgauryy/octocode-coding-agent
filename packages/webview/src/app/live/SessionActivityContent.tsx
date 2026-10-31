import type { ApplicationActivity } from "@octocodeai/octocode-contracts";
import { useState } from "react";
import { errorMessage } from "../model/format.ts";
import { Button } from "../ui/primitives.tsx";
import { ExpandedText, JsonDetails, type AssetLoader } from "./ContentBlocks.tsx";

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
	const key = full && `${full.id}:${full.revision ?? ""}`;
	const [loaded, setLoaded] = useState<{ key: string; value: unknown }>();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const current = loaded?.key === key ? loaded : undefined;
	const data = current ? current.value : activity.data;
	return (
		<>
			<ExpandedText text={text} full={json ? undefined : full} loadAsset={loadAsset} plain />
			{data !== undefined && <JsonDetails label="Details" value={data} />}
			{json && full && !current && (
				<Button
					size="sm"
					loading={loading}
					onClick={async () => {
						setLoading(true);
						setError("");
						try {
							setLoaded({ key: key!, value: JSON.parse(await (await loadAsset(full.id)).text()) });
						} catch (cause) {
							setError(errorMessage(cause));
						} finally {
							setLoading(false);
						}
					}}
				>
					Load full details
				</Button>
			)}
			{error && <p role="alert">{error}</p>}
		</>
	);
}
