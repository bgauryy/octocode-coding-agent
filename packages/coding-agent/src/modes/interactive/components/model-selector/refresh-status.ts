import type { ModelsRefreshResult } from "@octocodeai/octocode-ai";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ModelRuntime } from "../../../../core/model-runtime.ts";

/** The line under the model list once a catalog refresh settles: a warning, or the success note. */
export interface RefreshStatus {
	error?: string;
	message: string;
	refreshed: boolean;
}

const TIMED_OUT = "Model refresh timed out; showing cached models.";

/** What a settled refresh says: a timeout, the catalogs that failed, the runtime's own error, or success. */
export function refreshStatus(
	result: ModelsRefreshResult,
	timedOut: boolean,
	runtime: Pick<ModelRuntime, "getError">,
): RefreshStatus {
	const failed = [...result.errors.keys()];
	if (result.aborted && timedOut) return { error: TIMED_OUT, message: "", refreshed: false };
	if (failed.length === 1)
		return { error: `Could not refresh ${failed[0]}; showing cached models.`, message: "", refreshed: false };
	if (failed.length > 1)
		return {
			error: `Could not refresh ${failed.length} model catalogs (${failed.join(", ")}); showing cached models.`,
			message: "",
			refreshed: false,
		};
	const error = runtime.getError();
	return error ? { error, message: "", refreshed: false } : { message: "Model catalogs refreshed.", refreshed: true };
}

/** What a refresh that threw says. */
export function refreshFailure(error: unknown, timedOut: boolean): RefreshStatus {
	return {
		error: timedOut ? TIMED_OUT : `Could not refresh model catalogs: ${errorMessage(error)}`,
		message: "",
		refreshed: false,
	};
}
