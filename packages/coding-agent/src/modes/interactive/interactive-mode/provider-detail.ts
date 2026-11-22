import { applyBedrockAccessCheck, bedrockModelAccess, isBedrockCandidate } from "../../../core/bedrock-model-access.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { ModelConfig } from "../../../core/model-config.ts";
import type { ProviderEntry, ProviderSnapshot } from "../../../core/provider-view/snapshot.ts";
import { getModelsPath } from "../../../config.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import type { PageRow } from "../../../theme/manage-page.ts";
import { providerStatus, removeProviderCredential, setProviderEnabled } from "./provider-actions.ts";
import { providerDefinitionFile } from "./provider-custom.ts";
import {
	editCustomProviderHost,
	editCustomProviderLimits,
	effectiveBaseUrl,
	removeCustomProvider,
} from "./provider-custom-edit.ts";
import { chooseProviderModels } from "./provider-models-page.ts";
import { unsupportedPiSignIn } from "./provider-pi.ts";
import { providerBadge } from "./provider-rows.ts";
import { type PageContext, signInActions } from "./provider-signin.ts";
import { testProviderCredential } from "./provider-test.ts";
import { successNotice, showPage } from "./provider-ui.ts";

/** `again`: show the list again; `stop`: a dialog or the model picker took over. */
export type PageResult = "again" | "stop";

type Action = { run: () => void | Promise<void>; leaves?: boolean };

function removalLabel(entry: ProviderEntry, sessionOverride: boolean): string {
	return sessionOverride
		? "Remove saved and session credentials"
		: entry.stored?.type === "oauth"
			? "Sign out"
			: "Remove saved credential";
}

/**
 * One provider's page: its facts from the snapshot, then use, sign in or out, enable or disable. After an action the
 * caller's list rebuilds the snapshot; Escape returns to that list.
 */
export async function showProviderDetail(
	ctx: PageContext,
	id: string,
	refresh: () => Promise<ProviderSnapshot>,
): Promise<PageResult> {
	const { host } = ctx;
	const runtime = host.session.modelRuntime;
	const snapshot = await refresh();
	const entry = snapshot.entry(id);
	// A removed orphan leaves nothing to show.
	if (!entry) return "again";
	const { name, disabled } = entry;
	const sessionOverride = runtime.getProviderAuthStatus(id).source === "runtime";
	const actions = new Map<string, Action>();
	const models = runtime.getModels(id);
	const catalogSize = models.length;
	const hiddenCount = host.session.settingsManager.getHiddenModels()[id]?.length ?? 0;
	const removal: [string, Action] | undefined = entry.stored
		? [
				removalLabel(entry, sessionOverride),
				{
					run: async () => {
						await removeProviderCredential(host, id, name);
					},
				},
			]
		: undefined;
	// A credential that configures nothing: the fix comes first.
	if (removal && entry.state === "orphaned") actions.set(...removal);
	if (entry.models > 0) {
		if (!disabled)
			actions.set("Set as default provider for new chats", {
				run: async () => {
					await host.session.settingsManager.saveDefaultModelSelection(id, undefined);
					host.showStatus(`Saved global default provider: ${name}. New chats use its preferred model.`);
				},
			});
		actions.set("Choose a model for this chat", { run: () => host.showModelSelector(`${id}/`), leaves: true });
	}
	const bedrock = models.filter(isBedrockCandidate);
	if (bedrock.length && !disabled && runtime.getProviderAuthStatus(id).configured) {
		actions.set("Check account access for a model (no inference)", {
			run: async () => {
				const modelId = await host.showSelectorDialog(
					"Check Bedrock account access",
					bedrock.map((m) => m.id),
				);
				const model = bedrock.find((m) => m.id === modelId);
				if (!model) return;
				const generation = runtime.modelAccessGeneration;
				const access = await bedrockModelAccess(runtime, [model]);
				if (runtime.modelAccessGeneration !== generation) {
					host.showStatus("Provider configuration changed. Check model access again.");
					return;
				}
				applyBedrockAccessCheck(runtime, model, access.get(model), generation);
				host.showStatus(`${modelId}: ${access.get(model)}`);
			},
		});
	}
	if (catalogSize > 0) {
		actions.set("Choose models — tick which of this provider's models /model, Ctrl+P and subagents may use", {
			run: () => chooseProviderModels(host, id, name),
		});
	}
	if (runtime.getProviderAuthStatus(id).configured && entry.models > 0) {
		actions.set("Test — one small request, and which configured models the host serves", {
			run: () => testProviderCredential(host, id, name),
		});
	}
	for (const [label, run] of signInActions(ctx, id, name, snapshot.saved)) actions.set(label, { run, leaves: true });
	if (sessionOverride) {
		actions.set("Clear session API key override — keep saved credentials", {
			run: async () => {
				await runtime.removeRuntimeApiKey(id, { signal: AbortSignal.timeout(15_000) });
				host.updateAvailableProviderCount();
				host.showStatus(successNotice("Cleared session override for", name, `${await providerStatus(host, id)}.`));
			},
		});
	}
	if (removal && entry.state !== "orphaned") actions.set(...removal);
	let definition: Awaited<ReturnType<typeof providerDefinitionFile>>;
	try {
		definition = await providerDefinitionFile(host, id);
	} catch (error) {
		host.showError(errorMessage(error));
	}
	if (definition) {
		const { origin, path } = definition;
		if (origin === "Octocode") {
			actions.set("Edit host (base URL) of this custom provider", {
				run: async () => {
					await editCustomProviderHost(host, id, name, path);
				},
			});
			if (entry.models > 0) {
				actions.set("Edit context window and maximum output of a model", {
					run: async () => {
						await editCustomProviderLimits(host, id, name, path);
					},
				});
			}
			actions.set("Remove this custom provider from models.json", {
				run: async () => {
					await removeCustomProvider(host, id, name, path, entry.stored !== undefined);
				},
			});
		}
		actions.set(`Show definition file — ${origin} models.json: ${path}`, {
			run: () =>
				host.showStatus(
					`${name} is defined in ${path}. Edit that file, then open /model to refresh models (or restart).`,
				),
		});
	} else if (!entry.defined) {
		const path = homeTilde(getModelsPath());
		actions.set(`Show where to define it — ${path}`, {
			run: () =>
				host.showStatus(
					`Define provider "${id}" under "providers" in ${path}, then open /model to refresh models; or remove the credential saved in ${entry.credentialWhere}.`,
				),
		});
	}
	if (entry.defined) {
		actions.set(disabled ? "Enable provider" : "Disable provider", {
			run: () => setProviderEnabled(host, id, name, disabled),
		});
	}

	const piSignIn = await unsupportedPiSignIn(host, id, name).catch(() => undefined);
	// Fields its models.json ignores (a misspelled `apikey`) or an `api` no built-in serves explain "not configured".
	const definitionWarnings = definition
		? (await ModelConfig.loadFile(definition.path))
				.getWarnings()
				.filter((warning) => warning.includes(`: providers.${id}.`))
		: [];
	const baseUrl = await effectiveBaseUrl(host, id);
	const rows: PageRow[] = [...actions.keys()].map((label) => ({ id: label, name: label }));
	const catalog = catalogSize;
	// A plan's terms show before sign-in: who bills it, the vendor's page, and whether the route is retiring or paused.
	const plan = runtime.getProviderPlan(id);
	const paused = runtime.getPlanDisabledReason(id);
	const planFacts = plan
		? [
				{ label: "Billing", value: plan.billing === "plan" ? "Billed by plan" : "Billed per token" },
				{ label: "Plan terms", value: plan.terms },
				...(paused ? [{ label: "Paused", value: paused }] : []),
			]
		: [];
	const choice = await showPage(host, {
		title: `${name} — ${entry.statusText}`,
		facts: [
			{ label: "Status", value: `${providerBadge(entry).text} · ${entry.statusText}` },
			...(entry.nextStep ? [{ label: "Next step", value: entry.nextStep.label }] : []),
			{ label: "Access", value: "Not verified; Test sends a small request." },
			{ label: "Provider", value: disabled ? "off (hidden from /model)" : "on" },
			{
				label: "Models",
				value: `${entry.models} available · ${catalog} in catalog${hiddenCount > 0 ? ` · ${hiddenCount} hidden by you` : ""}`,
			},
			...(baseUrl ? [{ label: "Base URL", value: `${baseUrl.url} (${baseUrl.source})` }] : []),
			...planFacts,
			{
				label: "Definition",
				value: definition
					? `${definition.origin} models.json · ${definition.path}`
					: entry.defined
						? "built-in (no models.json entry)"
						: `missing; only a saved credential remains (define it in ${homeTilde(getModelsPath())})`,
			},
			...(piSignIn ? [{ label: "Pi sign-in", value: piSignIn }] : []),
			...definitionWarnings.map((value) => ({ label: "Warning", value })),
		],
		sections: [{ heading: "ACTIONS", rows }],
		nested: true,
	});
	const action = choice ? actions.get(choice.id) : undefined;
	if (!action) return "again";
	await action.run();
	return action.leaves ? "stop" : "again";
}
