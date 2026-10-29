import {
	WORKSPACE_ROUTES,
	type ApplicationAsset,
	type ApplicationAssetPayload,
	type ApplicationHistory,
} from "@octocodeai/octocode-contacts";

import { requestJson } from "../../request.ts";
import { scopedRoute } from "../../scope.ts";

/** Assets stay behind the same capability as the session. Only decoded bytes reach object URLs. */
export function createApplicationApi(access: string) {
	const authorization = { Authorization: `Bearer ${access}` };
	return {
		async asset(sessionId: string, id: string, signal?: AbortSignal): Promise<Blob> {
			const value = await requestJson(
				`${scopedRoute(WORKSPACE_ROUTES.assets)}/${encodeURIComponent(id)}?${new URLSearchParams({ sessionId })}`,
				{
					headers: authorization,
					signal,
				},
			);
			if (
				!isRecord(value) ||
				!isAsset(value.asset) ||
				value.asset.id !== id ||
				typeof value.data !== "string" ||
				(value.encoding !== "base64" && value.encoding !== "utf8")
			)
				throw new Error("Invalid content response");
			const payload = value as unknown as ApplicationAssetPayload;
			const data =
				payload.encoding === "base64"
					? Uint8Array.from(atob(payload.data), (character) => character.charCodeAt(0))
					: payload.data;
			return new Blob([data], { type: payload.asset.mimeType });
		},
		async upload(sessionId: string, file: File): Promise<ApplicationAsset> {
			const data = await fileData(file);
			const value = await requestJson(scopedRoute(WORKSPACE_ROUTES.assets), {
				method: "POST",
				headers: { ...authorization, "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId, mimeType: file.type, name: file.name, data }),
			});
			if (!isRecord(value) || !isAsset(value.asset)) throw new Error("Invalid attachment response");
			return value.asset;
		},
		async history(sessionId: string, before?: string, activityBefore?: string): Promise<ApplicationHistory> {
			const value = await requestJson(
				`${scopedRoute(WORKSPACE_ROUTES.history)}?${new URLSearchParams({
					sessionId,
					limit: "50",
					...(before ? { before } : {}),
					...(activityBefore ? { activityBefore } : {}),
				})}`,
				{ headers: authorization },
			);
			if (
				!isRecord(value) ||
				!Array.isArray(value.messages) ||
				!Array.isArray(value.tools) ||
				typeof value.hasMore !== "boolean"
			)
				throw new Error("Invalid history response");
			return value as unknown as ApplicationHistory;
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
function isAsset(value: unknown): value is ApplicationAsset {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.mimeType === "string" &&
		typeof value.size === "number"
	);
}
function fileData(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const value = reader.result;
			if (typeof value !== "string" || !value.includes(",")) reject(new Error("Could not read attachment"));
			else resolve(value.slice(value.indexOf(",") + 1));
		};
		reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
		reader.onabort = () => reject(new Error("Attachment read cancelled"));
		reader.readAsDataURL(file);
	});
}
