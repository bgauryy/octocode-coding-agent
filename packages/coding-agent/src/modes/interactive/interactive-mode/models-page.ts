import { applyProviderVisibility, isModelHidden, setProviderHiddenModels } from "../../../core/provider-models.ts";
import { noticeDisabledProvider } from "../../../core/provider-sources/notice.ts";
import { buildProviderSnapshot } from "../../../core/provider-view/snapshot.ts";
import type { PageRow, PageSection } from "../../../theme/manage-page.ts";
import { badge } from "../../../theme/page-kit.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { showPage, successNotice } from "./provider-ui.ts";

const ID_SEPARATOR = "\u0000";
const rowId = (provider: string, model: string): string => `${provider}${ID_SEPARATOR}${model}`;

/**
 * `/models`: every enabled provider as a heading with its models under it. Enter toggles a model on or off (the
 * global `hiddenModels` setting, applied to the running session at once) and `d` makes it the default for new chats.
 */
export async function showModelsPage(host: ProviderManagerHost): Promise<void> {
	const { modelRuntime: runtime, settingsManager } = host.session;
	let initialId: string | undefined;
	for (;;) {
		const snapshot = await buildProviderSnapshot({
			runtime,
			disabledProviders: settingsManager.getDisabledProviders(),
		});
		const hidden = settingsManager.getHiddenModels();
		const sections: PageSection[] = [];
		for (const entry of snapshot.providers) {
			if (entry.disabled || entry.state !== "ready") continue;
			const models = runtime.getModels(entry.id);
			if (models.length === 0) continue;
			const rows: PageRow[] = models.map((model) => {
				const shown = badge(isModelHidden(hidden, entry.id, model.id) ? "off" : "ready");
				return {
					id: rowId(entry.id, model.id),
					name: model.id,
					detail: model.name && model.name !== model.id ? model.name : undefined,
					badge: shown.text,
					tone: shown.tone,
					keys: { d: "default" },
				};
			});
			sections.push({ heading: entry.name, rows });
		}
		const choice = await showPage(host, {
			title: "Models",
			sections: sections.length
				? sections
				: [{ heading: "Providers", rows: [], empty: "no enabled provider — use /providers" }],
			notes: [
				"Off models leave /model, Ctrl+P and subagents. Enter toggles one; d makes it the default for new chats.",
			],
			initialId,
			enter: "toggle",
		});
		if (!choice) return;
		initialId = choice.id;
		const [provider, model] = choice.id.split(ID_SEPARATOR);
		if (!provider || !model) continue;
		if (choice.key === "d") {
			await settingsManager.saveDefaultModelSelection(provider, model);
			host.showStatus(`Saved global default model: ${provider}/${model}.`);
			continue;
		}
		const current = settingsManager.getHiddenModels()[provider] ?? [];
		const next = current.includes(model) ? current.filter((id) => id !== model) : [...current, model];
		setProviderHiddenModels(settingsManager, provider, next);
		applyProviderVisibility(runtime, settingsManager);
		noticeDisabledProvider(host.session);
		host.updateAvailableProviderCount();
		host.showStatus(
			successNotice(next.includes(model) ? "Turned off" : "Turned on", `${provider}/${model}`, "Saved to settings."),
		);
	}
}
