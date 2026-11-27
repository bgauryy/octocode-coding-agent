import type { ApplicationAsset } from "@octocodeai/octocode-contracts";
import { useState } from "react";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Button } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

/** Uploaded ids belong to the current session; changing sessions discards the tab's pending attachments. */
export function SessionAttachments({
	sessionId,
	value,
	disabled,
	acceptsImages = true,
	onChange,
	onUploading,
}: {
	sessionId: string;
	value: readonly ApplicationAsset[];
	disabled: boolean;
	acceptsImages?: boolean;
	onChange: (assets: ApplicationAsset[]) => void;
	onUploading: (uploading: boolean) => void;
}) {
	const { api, session } = useLive();
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	async function upload(files: File[]) {
		if (!files.length || disabled || !acceptsImages) return;
		if (files.length + value.length > 20) {
			setError("Attach up to 20 images per message.");
			return;
		}
		setUploading(true);
		onUploading(true);
		setError("");
		const assets = [...value];
		try {
			for (const file of files) {
				const asset = await api.upload(sessionId, file);
				if (session.getState().application?.sessionId !== sessionId) return;
				assets.push(asset);
				onChange([...assets]);
			}
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setUploading(false);
			onUploading(false);
		}
	}
	return (
		<div className="composer-attachments">
			<label className="attachment-picker">
				Attach images
				<input
					type="file"
					accept="image/png,image/jpeg,image/webp,image/gif"
					multiple
					disabled={disabled || uploading || !acceptsImages}
					onChange={(event) => {
						const files = [...(event.target.files ?? [])];
						event.target.value = "";
						void upload(files);
					}}
				/>
			</label>
			{uploading && <output>Uploading images…</output>}
			{error && <p role="alert">{error}</p>}
			{value.length > 0 && (
				<ul aria-label="Attached images">
					{value.map((asset) => (
						<li key={asset.id}>
							<span>{asset.name ?? asset.mimeType}</span>
							<Button
								size="sm"
								variant="ghost"
								disabled={disabled || uploading}
								aria-label={`Remove ${asset.name ?? "image"}`}
								onClick={() => onChange(value.filter((item) => item.id !== asset.id))}
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
