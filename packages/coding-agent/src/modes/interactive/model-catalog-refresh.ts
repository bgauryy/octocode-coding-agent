import type { ModelsRefreshResult } from "@octocodeai/octocode-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { raceWithAbortSignal } from "@octocodeai/octocode-ai/utils/abort";

type ModelCatalogRuntime = Pick<ModelRuntime, "refresh">;

interface ActiveModelCatalogRefresh {
	controller: AbortController;
	promise: Promise<ModelsRefreshResult>;
	waiters: number;
}

class ModelCatalogRefreshCoordinator {
	private readonly activeByRuntime = new WeakMap<ModelCatalogRuntime, ActiveModelCatalogRefresh>();

	refresh(modelRuntime: ModelCatalogRuntime, signal: AbortSignal): Promise<ModelsRefreshResult> {
		signal.throwIfAborted();
		let active = this.activeByRuntime.get(modelRuntime);
		if (!active) {
			const controller = new AbortController();
			// An open within the reuse window answers from the last clean refresh; availability is still re-checked.
			const operation = modelRuntime.refresh({ signal: controller.signal, reuse: true });
			const created: ActiveModelCatalogRefresh = {
				controller,
				// The cleanup runs asynchronously, after `created` is initialized.
				promise: raceWithAbortSignal(operation, controller.signal).finally(() => {
					if (this.activeByRuntime.get(modelRuntime) === created) {
						this.activeByRuntime.delete(modelRuntime);
					}
				}),
				waiters: 0,
			};
			active = created;
			this.activeByRuntime.set(modelRuntime, active);
		}

		active.waiters++;
		return raceWithAbortSignal(active.promise, signal).finally(() => {
			active.waiters--;
			if (active.waiters === 0 && this.activeByRuntime.get(modelRuntime) === active) {
				active.controller.abort();
			}
		});
	}
}

const modelCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator();

/** Share concurrent interactive all-catalog refreshes while keeping each caller's cancellation independent. */
export function refreshModelCatalogs(
	modelRuntime: ModelCatalogRuntime,
	signal: AbortSignal,
): Promise<ModelsRefreshResult> {
	return modelCatalogRefreshCoordinator.refresh(modelRuntime, signal);
}
