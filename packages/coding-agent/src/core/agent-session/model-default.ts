import type { Model } from "@octocodeai/octocode-ai/compat";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ModelSettingsApi } from "../settings-manager/api/model.ts";

type Selection = Pick<Model<any>, "provider" | "id">;

/** The session switched successfully, but its requested startup default could not be saved. */
export class DefaultModelSaveError extends Error {
	constructor(model: Selection, cause: unknown) {
		super(
			`Using ${model.provider}/${model.id} for this chat. Could not save the default model: ${errorMessage(cause)}`,
			{ cause },
		);
		this.name = "DefaultModelSaveError";
	}
}

export async function persistDefaultModel(
	settings: Pick<ModelSettingsApi, "saveDefaultModelSelection">,
	model: Selection,
	enabledModels?: string[],
	scope: "global" | "project" = "global",
): Promise<void> {
	try {
		await settings.saveDefaultModelSelection(model.provider, model.id, { enabledModels, scope });
	} catch (error) {
		throw new DefaultModelSaveError(model, error);
	}
}

/** Keep a newly saved startup model reachable when a global shortcut list is in use. */
export function includeDefaultModel(patterns: string[] | undefined, model: Selection): string[] | undefined {
	if (!patterns?.length) return;
	const reference = `${model.provider}/${model.id}`;
	if (!patterns.some((pattern) => pattern.toLowerCase() === reference.toLowerCase())) return [...patterns, reference];
}
