import type { OAuthCredential } from "../auth/types.ts";
import type { Api, Model } from "../types.ts";
import type { DiscoveredVendorModel } from "./discovery.ts";

export function chatGPTAccountKey(credential: OAuthCredential): string {
	return `${typeof credential.clientId === "string" ? credential.clientId : ""}\0${typeof credential.subject === "string" ? credential.subject : ""}`;
}

/** Preserve the vendor's visibility/order/name while keeping trusted runtime metadata. */
export function chatGPTModels<T extends Api>(
	models: readonly Model<T>[],
	credential: OAuthCredential,
	listed?: readonly DiscoveredVendorModel[],
): Model<T>[] {
	const rows = listed ?? (Array.isArray(credential.availableModels) ? credential.availableModels : []);
	const catalog = new Map(models.map((model) => [model.id, model]));
	const result: Model<T>[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string") continue;
		const model = catalog.get(row.id);
		if (!model) continue;
		result.push({ ...model, ...("name" in row && typeof row.name === "string" ? { name: row.name } : {}) });
		catalog.delete(row.id);
	}
	return result;
}
