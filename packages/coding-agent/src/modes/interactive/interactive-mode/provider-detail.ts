import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { ModelConfig } from "../../../core/model-config.ts";
import type { ProviderEntry, ProviderSnapshot } from "../../../core/provider-view/snapshot.ts";
import { getModelsPath } from "../../../config.ts";
import { homeTilde } from "../../../../../common/src/home-tilde.ts";
import type { PageRow } from "../../../theme/manage-page.ts";
import { providerStatus, removeProviderCredential, setProviderEnabled } from "./provider-actions.ts";
import { providerDefinitionFile } from "./provider-custom.ts";
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
		actions.set("Choose a model for this chat", { run: () => host.showModelSelector(`${id}/`), leaves: true });
	}
	if (runtime.getProviderAuthStatus(id).configured && entry.models > 0) {
		actions.set("Test credential — send one small request to this provider", {
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
	const rows: PageRow[] = [...actions.keys()].map((label) => ({ id: label, name: label }));
	const catalog = runtime.getModels(id).length;
	// A plan's terms show before sign-in: who bills it, the vendor's page, and whether the route is retiring or paused.
	const plan = runtime.getProviderPlan(id);
	const paused = runtime.getPlanDisabledReason(id);
	const planFacts = plan
		? [
				{ label: "Billing", value: plan.billing === "plan" ? "Billed by plan" : "Billed per token" },
				{ label: "Plan terms", value: plan.terms },
				...(plan.deprecated ? [{ label: "Deprecated", value: plan.deprecated }] : []),
				...(paused ? [{ label: "Paused", value: paused }] : []),
			]
		: [];
	const choice = await showPage(host, {
		title: `${name} — ${entry.statusText}`,
		facts: [
			{ label: "Status", value: `${providerBadge(entry).text} · ${entry.statusText}` },
			...(entry.nextStep ? [{ label: "Next step", value: entry.nextStep.label }] : []),
			{ label: "Access", value: "Not verified; Test credential sends a small request." },
			{ label: "Provider", value: disabled ? "off (hidden from /model)" : "on" },
			{ label: "Models", value: `${entry.models} available · ${catalog} in catalog` },
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
