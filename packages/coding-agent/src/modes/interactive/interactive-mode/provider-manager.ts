import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { describeProviderSources } from "../../../core/provider-sources/index.ts";
import type { ProviderSourceEnvironment } from "../../../core/provider-sources/types.ts";
import { keyText } from "../../../theme/theme-tui-helpers.ts";
import type { PageSection } from "../../../theme/manage-page.ts";
import type { CredentialState } from "../../../core/provider-composer/credential-state.ts";
import {
	claudeSubscriptionRefusal,
	isProviderDisabled,
	providerCredentialState,
	setProviderEnabled,
} from "./provider-actions.ts";
import { showProviderDetail } from "./provider-detail.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { showPiProviders } from "./provider-pi.ts";
import {
	externalAgentSignIns,
	listedRunners,
	runnerSection,
	setRunnerEnabled,
	showRunnerDetail,
} from "./provider-runners.ts";
import { type PageContext, showSignIn } from "./provider-signin.ts";
import { showProviderTemplates } from "./provider-template.ts";
import { showSourcesPage } from "./provider-sources-page.ts";
import { providerRows } from "./provider-rows.ts";
import { showPage } from "./provider-ui.ts";

const SIGN_IN_ROW = "signin";
const TEMPLATE_ROW = "template";
const ADVANCED_ROW = "advanced";

export interface ProviderManagerOptions {
	/** Where to look for sources and detected tools; tests point it at a temporary home. */
	sourceEnvironment?: ProviderSourceEnvironment;
}

/**
 * `/providers`: the main page lists providers by state, then sources, detected tools and custom models files. Sign-in is
 * one action row that opens its own flow. `query` opens a provider's page when it names one, `pi` the Pi import list,
 * and anything else the sign-in picker filtered by it.
 */
export async function showProviderManager(
	host: ProviderManagerHost,
	query = "",
	options: ProviderManagerOptions = {},
): Promise<void> {
	const wanted = query.trim().toLowerCase();
	const ctx: PageContext = {
		host,
		reopen: (id) => {
			showProviderManager(host, id ?? "", options).catch((error: unknown) => host.showError(errorMessage(error)));
		},
	};
	if (wanted === "pi") {
		const pi = describeProviderSources(
			host.session.settingsManager.getProviderSources(),
			options.sourceEnvironment,
		).find((source) => source.id === "pi");
		if (pi && !pi.state.enabled) {
			host.showStatus(
				"The Pi source is off. Turn it on in /providers → Advanced → Sources and custom models to use its providers and sign-ins.",
			);
			return;
		}
		await showPiProviders(host, async (id) => showProviderManager(host, id, options));
		return;
	}
	let initialId: string | undefined;
	for (;;) {
		let saved: readonly CredentialInfo[];
		try {
			saved = await host.session.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) });
		} catch {
			host.showError("Could not read saved provider credentials. No credentials were changed.");
			return;
		}
		const { modelRuntime: runtime, settingsManager } = host.session;
		const ids = new Set([
			...runtime.getProviders().map((provider) => provider.id),
			...saved.map((entry) => entry.providerId),
		]);
		const runners = listedRunners(options.sourceEnvironment, (message) => host.showWarning(message));
		const nameOf = (id: string) => runtime.getProvider(id)?.name ?? id;
		// An external agent picked in **+ Add a provider** opens its own page: install, its own login, enable for tasks.
		const openRunner = (rowId: string) =>
			showRunnerDetail(host, rowId.slice(rowId.indexOf(":") + 1), runners, { source: options.sourceEnvironment });
		if (wanted && initialId === undefined) {
			const exact = [...ids].find((id) => [id, nameOf(id)].some((value) => value.toLowerCase() === wanted));
			if (exact) {
				await showProviderDetail(ctx, exact, saved);
				return;
			}
			const runner = runners.find((entry) =>
				[entry.id, entry.name, `runner:${entry.id}`].some((value) => value.toLowerCase() === wanted),
			);
			if (runner) {
				await showRunnerDetail(host, runner.id, runners, { source: options.sourceEnvironment });
				return;
			}
			const picked = await showSignIn(ctx, saved, query, externalAgentSignIns());
			if (typeof picked === "string") await openRunner(picked);
			return;
		}
		// A saved credential that configures nothing because it is a Claude subscription token: the row says so.
		const refused = new Set<string>();
		await Promise.all(
			saved
				.filter((entry) => !runtime.getProviderAuthStatus(entry.providerId).configured)
				.map(async ({ providerId }) => {
					if (await claudeSubscriptionRefusal(host, providerId)) refused.add(providerId);
				}),
		);
		const states = new Map<string, CredentialState>();
		await Promise.all(
			saved
				.filter((entry) => entry.type === "oauth")
				.map(async ({ providerId }) => states.set(providerId, await providerCredentialState(host, providerId))),
		);
		const rows = providerRows(runtime, settingsManager.getDisabledProviders(), saved, refused, states);
		const sections: PageSection[] = [
			...(rows.attention.length ? [{ heading: "Needs attention", rows: rows.attention }] : []),
			{ heading: "Configured", rows: rows.configured, empty: "none yet — choose Add a provider" },
			...(rows.disabled.length ? [{ heading: "Disabled", rows: rows.disabled }] : []),
			{
				heading: "Connect",
				rows: [
					{
						id: SIGN_IN_ROW,
						name: "+ Add a provider",
						detail: "a subscription sign-in or an API key, or an external agent CLI",
					},
					{
						id: TEMPLATE_ROW,
						name: "+ Add from a template",
						detail: "another API-key host, a gateway or a local server, written to models.json",
					},
				],
			},
			runnerSection(runners, settingsManager.getExternalAgents(), settingsManager.getEnabledExternalAgents()),
			{
				heading: "Advanced",
				rows: [
					{
						id: ADVANCED_ROW,
						name: "Sources and custom models",
						detail: "credential sources, detected tools and model definition files",
					},
				],
			},
		];
		const choice = await showPage(host, {
			title: "AI providers",
			notes: [
				"Provider credentials are configured, not verified. Open a provider to test access.",
				"Providers run in Octocode's harness; external agents are vendor CLIs that run their own. Enable each agent for tasks.",
			],
			sections,
			initialId,
			keys: ["e"],
			hints: [
				[keyText("tui.select.confirm"), "open", 0],
				["e", "enable/disable", 2],
				[keyText("tui.select.cancel"), "close", 0],
			],
		});
		if (!choice) return;
		initialId = choice.id;
		try {
			const [kind, ...rest] = choice.id.split(":");
			const key = rest.join(":");
			let result: "again" | "stop" = "again";
			if (choice.id === SIGN_IN_ROW) {
				const picked = await showSignIn(ctx, saved, "", externalAgentSignIns());
				result = typeof picked === "string" ? await openRunner(picked) : picked ? "stop" : "again";
			} else if (choice.id === TEMPLATE_ROW)
				result = (await showProviderTemplates(host, ctx.reopen, saved)) ? "stop" : "again";
			else if (choice.id === ADVANCED_ROW) result = await showSourcesPage(ctx, saved, options.sourceEnvironment);
			else if (kind === "provider") {
				if (choice.key) setProviderEnabled(host, key, nameOf(key), isProviderDisabled(host, key));
				else result = await showProviderDetail(ctx, key, saved);
			} else if (kind === "runner") {
				if (choice.key) {
					const selected = settingsManager.getEnabledExternalAgents();
					setRunnerEnabled(
						host,
						key,
						!(settingsManager.getExternalAgents() && (selected === undefined || selected.includes(key))),
					);
				} else result = await showRunnerDetail(host, key, runners, { source: options.sourceEnvironment });
			}
			if (result === "stop") return;
		} catch (error) {
			host.showError(errorMessage(error));
		}
	}
}
