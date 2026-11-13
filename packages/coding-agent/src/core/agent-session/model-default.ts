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
): Promise<void> {
	try {
		await settings.saveDefaultModelSelection(model.provider, model.id, { enabledModels });
	} catch (error) {
		throw new DefaultModelSaveError(model, error);
	}
}
