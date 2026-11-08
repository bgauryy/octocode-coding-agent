import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { keyText } from "../components/keybinding-hints.ts";
import type { PageRow } from "../components/manage-page.ts";
import {
	isProviderDisabled,
	providerStatus,
	removeProviderCredential,
	setProviderEnabled,
} from "./provider-actions.ts";
import { providerDefinitionFile } from "./provider-custom.ts";
import { type PageContext, signInActions } from "./provider-signin.ts";
import { successNotice, showPage } from "./provider-ui.ts";

/** `again`: show the list again; `stop`: a dialog or the model picker took over. */
export type PageResult = "again" | "stop";

/** One provider's page: its facts, then sign in or out, enable or disable and model selection. */
export async function showProviderDetail(
	ctx: PageContext,
	id: string,
	saved: readonly CredentialInfo[],
): Promise<PageResult> {
	const { host } = ctx;
	const runtime = host.session.modelRuntime;
	const name = runtime.getProvider(id)?.name ?? id;
	const disabled = isProviderDisabled(host, id);
	const sessionOverride = runtime.getProviderAuthStatus(id).source === "runtime";
	const savedEntry = saved.find((entry) => entry.providerId === id);
	const actions = new Map<string, { run: () => void | Promise<void>; leaves?: boolean }>();

	if (sessionOverride) {
		actions.set("Clear session API key override — keep saved credentials", {
			run: async () => {
				await runtime.removeRuntimeApiKey(id, { signal: AbortSignal.timeout(15_000) });
				host.updateAvailableProviderCount();
				host.showStatus(successNotice("Cleared session override for", name, `${providerStatus(host, id)}.`));
			},
		});
	}
	const available = runtime.getAvailableSnapshot().filter((model) => model.provider === id).length;
	if (available > 0) {
		actions.set("Choose a model for this chat", { run: () => host.showModelSelector(`${id}/`), leaves: true });
	}
	for (const [label, run] of signInActions(ctx, id, name, saved)) actions.set(label, { run, leaves: true });
	if (savedEntry) {
		actions.set(
			sessionOverride
				? "Remove saved and session credentials"
				: savedEntry.type === "oauth"
					? "Sign out"
					: "Remove saved credential",
			{
				run: async () => {
					await removeProviderCredential(host, id, name);
				},
			},
		);
	}
	let definition: Awaited<ReturnType<typeof providerDefinitionFile>>;
	try {
		definition = await providerDefinitionFile(host, id);
	} catch (error) {
		host.showError(errorMessage(error));
	}
	if (definition) {
		const { origin, path } = definition;
		actions.set(`Edit definition — ${origin} models.json: ${path}`, {
			run: () =>
				host.showStatus(
					`${name} is defined in ${path}. Edit that file, then open /model to refresh models (or restart).`,
				),
		});
	}
	actions.set(disabled ? "Enable provider" : "Disable provider", {
		run: () => setProviderEnabled(host, id, name, disabled),
	});

	const rows: PageRow[] = [...actions.keys()].map((label) => ({ id: label, name: label }));
	const catalog = runtime.getModels(id).length;
	const choice = await showPage(host, {
		title: `${name} — ${disabled ? "disabled" : runtime.getProviderAuthStatus(id).configured ? "configured" : "not configured"}`,
		facts: [
			{ label: "Status", value: disabled ? `disabled · ${providerStatus(host, id)}` : providerStatus(host, id) },
			{ label: "Provider", value: disabled ? "disabled (hidden from /model)" : "enabled" },
			{ label: "Models", value: `${available} available · ${catalog} in catalog` },
			{
				label: "Definition",
				value: definition ? `${definition.origin} models.json · ${definition.path}` : "built-in (no models.json entry)",
			},
		],
		sections: [{ heading: "ACTIONS", rows }],
		hints: [
			[keyText("tui.select.confirm"), "run", 0],
			[keyText("tui.select.cancel"), "back", 1],
		],
	});
	const action = choice ? actions.get(choice.id) : undefined;
	if (!action) return "again";
	await action.run();
	return action.leaves ? "stop" : "again";
}
