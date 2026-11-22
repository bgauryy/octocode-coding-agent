import { applyProviderVisibility, setProviderTickedModels } from "../../../core/provider-models.ts";
import { noticeDisabledProvider } from "../../../core/provider-sources/notice.ts";
import { ScopedModelsSelectorComponent } from "../components/scoped-models-selector.ts";
import { providerAccessLabel } from "../../../core/provider-label.ts";
import { keyText } from "../../../theme/theme-tui-helpers.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { successNotice } from "./provider-ui.ts";

type ModelsHost = Pick<
	ProviderManagerHost,
	"session" | "showSelector" | "showStatus" | "updateAvailableProviderCount"
> & {
	ui: { requestRender(): void; terminal: { rows: number } };
};

/**
 * A provider's checkbox list of models. Unticked models leave `/model`, Ctrl+P and subagent routing; the choice is
 * saved to the global settings with the save key and applied to the running session at once. Resolves when it closes.
 */
export function chooseProviderModels(view: ModelsHost, id: string, name: string): Promise<void> {
	const { modelRuntime: runtime, settingsManager } = view.session;
	const models = [...runtime.getModels(id)];
	return new Promise((resolve) => {
		view.showSelector((done) => {
			const hidden = new Set(settingsManager.getHiddenModels()[id]);
			const ticked = models.filter((model) => !hidden.has(model.id)).map((model) => `${id}/${model.id}`);
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels: models,
					enabledModelIds: ticked.length === models.length ? null : ticked,
					title: `${name} — choose models`,
					subtitle: `Unticked models are hidden from /model, Ctrl+P and subagents. ${keyText("app.models.save")} saves.`,
					providerKind: (provider) => providerAccessLabel(runtime, provider),
					rows: view.ui.terminal.rows,
				},
				{
					onChange: () => {},
					onPersist: (enabledIds) => {
						const keep =
							enabledIds === null
								? models.map((model) => model.id)
								: enabledIds.map((each) => each.slice(id.length + 1));
						setProviderTickedModels(
							settingsManager,
							id,
							models.map((model) => model.id),
							keep,
						);
						applyProviderVisibility(runtime, settingsManager);
						noticeDisabledProvider(view.session);
						view.updateAvailableProviderCount();
						const shown = models.filter((model) => keep.includes(model.id)).length;
						view.showStatus(successNotice("Saved models for", name, `${shown} of ${models.length} shown.`));
					},
					requestRender: () => view.ui.requestRender(),
					onCancel: () => {
						done();
						resolve();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	});
}
