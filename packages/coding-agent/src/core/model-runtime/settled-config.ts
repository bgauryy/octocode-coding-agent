import { getFileRevision } from "@octocodeai/octocode-common/paths";
import { ModelConfig } from "../model-config.ts";
import type { ModelsProject } from "../model-config/project.ts";

/** How long models.json must stay unchanged after a read before the result is trusted: an editor's save settles within it. */
const SETTLE_MS = 300;
const MAX_ATTEMPTS = 5;

/**
 * Loads models.json and returns the result only once the file kept the same revision across a short settle, so a
 * truncated or half-written state is never the one applied. A file that keeps changing is read one last time after
 * the attempts run out. The caller still checks `isUnreadable()`: an invalid file that stays invalid is reported.
 */
export async function loadSettledConfig(
	modelsPath: string | undefined,
	settleMs = SETTLE_MS,
	project?: ModelsProject,
): Promise<ModelConfig> {
	if (!modelsPath) return ModelConfig.load(modelsPath, project);
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const revision = getFileRevision(modelsPath);
		const config = await ModelConfig.load(modelsPath, project);
		await new Promise((resolve) => setTimeout(resolve, settleMs));
		if (getFileRevision(modelsPath) === revision) return config;
	}
	return ModelConfig.load(modelsPath, project);
}
