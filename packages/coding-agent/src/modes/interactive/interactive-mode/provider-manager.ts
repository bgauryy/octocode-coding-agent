import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { describeProviderSources } from "../../../core/provider-sources/index.ts";
import type { ProviderSourceEnvironment } from "../../../core/provider-sources/types.ts";
import { buildProviderSnapshot, type ProviderSnapshot } from "../../../core/provider-view/snapshot.ts";
import type { PageSection } from "../../../theme/manage-page.ts";
import { type BadgeState } from "../../../theme/page-kit.ts";
import { testAllProviders } from "./provider-test.ts";
import { isProviderDisabled, setProviderEnabled } from "./provider-actions.ts";
import { showProviderDetail } from "./provider-detail.ts";
import { chooseProviderModels } from "./provider-models-page.ts";
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
import { loadModelFiles, modelFileRows, showSourcesPage } from "./provider-sources-page.ts";
import { providerRows } from "./provider-rows.ts";
import { showPage } from "./provider-ui.ts";

const SIGN_IN_ROW = "signin";
const TEMPLATE_ROW = "template";
const EXTERNAL_ROW = "external";
const ADVANCED_ROW = "advanced";
const TEST_ALL_ROW = "test-all";

export interface ProviderManagerOptions {
	/** Where to look for sources and detected tools; tests point it at a temporary home. */
	sourceEnvironment?: ProviderSourceEnvironment;
	/** Close after the named provider's page instead of continuing to the list; the caller shows its own list. */
	detailOnly?: boolean;
}

/**
 * `/providers`: the models.json files, Needs attention, Ready, Available (built-ins not set up yet), Off, then the
 * Add rows and Advanced. All provider state comes from one snapshot, rebuilt each time the list shows. `query`
 * opens a provider's page when it names one (Escape then returns to the list), `pi` the Pi import list, and anything else the sign-in picker filtered by it.
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
		await showPiProviders(host, async (id) => showProviderManager(host, id, { ...options, detailOnly: true }));
		return;
	}
	const { modelRuntime: runtime, settingsManager } = host.session;
	const refresh = (): Promise<ProviderSnapshot> =>
		buildProviderSnapshot({ runtime, disabledProviders: settingsManager.getDisabledProviders() });
	let initialId: string | undefined;
	for (;;) {
		let snapshot: ProviderSnapshot;
		try {
			snapshot = await refresh();
		} catch {
			host.showError("Could not read saved provider credentials. No credentials were changed.");
			return;
		}
		const runners = listedRunners(options.sourceEnvironment, (message) => host.showWarning(message));
		// An external agent picked in **+ External agent CLI** opens its own page: install, its own login, enable for tasks.
		const openRunner = (rowId: string) =>
			showRunnerDetail(host, rowId.slice(rowId.indexOf(":") + 1), runners, { source: options.sourceEnvironment });
		if (wanted && initialId === undefined) {
			const exact = snapshot.providers.find((entry) =>
				[entry.id, entry.name].some((value) => value.toLowerCase() === wanted),
			);
			if (exact) {
				if ((await showProviderDetail(ctx, exact.id, refresh)) === "stop" || options.detailOnly) return;
				initialId = `provider:${exact.id}`;
				continue;
			}
			const runner = runners.find((entry) =>
				[entry.id, entry.name, `runner:${entry.id}`].some((value) => value.toLowerCase() === wanted),
			);
			if (runner) {
				await openRunner(runner.id);
				if (options.detailOnly) return;
				initialId = `runner:${runner.id}`;
				continue;
			}
			const picked = await showSignIn(ctx, snapshot.saved, query, externalAgentSignIns());
			if (typeof picked === "string") await openRunner(picked);
			return;
		}
		const rows = providerRows(snapshot);
		const runnerStates: BadgeState[] = runners.length ? ["ready", "off"] : [];
		const { files } = await loadModelFiles(ctx, options.sourceEnvironment);
		const sections: PageSection[] = [
			{ heading: "Model files", rows: modelFileRows(files), empty: "no models.json found" },
			...(rows.attention.length ? [{ heading: "Needs attention", rows: rows.attention }] : []),
			{ heading: "Ready", rows: rows.ready, empty: "none yet — choose + Provider" },
			...(rows.available.length ? [{ heading: "Available", rows: rows.available }] : []),
			...(rows.off.length ? [{ heading: "Off", rows: rows.off }] : []),
			runnerSection(runners, settingsManager.getExternalAgents(), settingsManager.getEnabledExternalAgents()),
			{
				heading: "Add",
				rows: [
					{
						id: SIGN_IN_ROW,
						name: "+ Provider",
						detail: "a subscription sign-in or an API key",
					},
					{
						id: TEMPLATE_ROW,
						name: "+ From template",
						detail: "another API-key host, a gateway or a local server, written to models.json",
					},
					{
						id: EXTERNAL_ROW,
						name: "+ External agent CLI",
						detail: "a vendor CLI that runs tasks in its own harness",
					},
				],
			},
			{
				heading: "Test",
				rows: [
					{
						id: TEST_ALL_ROW,
						name: "Test all",
						detail: "one small request per connected provider, and each external agent's own status check",
					},
				],
			},
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
		const reloadError = runtime.getReloadError();
		// The files lead the page, but the cursor starts on the first provider: that is what Enter is for.
		initialId ??= [...rows.attention, ...rows.ready, ...rows.off, ...rows.available][0]?.id;
		const choice = await showPage(host, {
			title: "AI providers",
			notes: [
				...(reloadError
					? [`Changes to models.json or auth.json were not applied; the previous providers stay loaded. ${reloadError}`]
					: []),
				"Ready means configured, not verified. Open a provider to test access.",
				"Providers run in Octocode's harness; external agents are vendor CLIs that run their own. Enable each agent for tasks.",
			],
			sections,
			initialId,
			legend: [...rows.states, ...runnerStates],
		});
		if (!choice) return;
		initialId = choice.id;
		try {
			const [kind, ...rest] = choice.id.split(":");
			const key = rest.join(":");
			let result: "again" | "stop" = "again";
			if (choice.id === SIGN_IN_ROW) {
				const picked = await showSignIn(ctx, snapshot.saved);
				result = picked ? "stop" : "again";
			} else if (choice.id === TEMPLATE_ROW)
				result = (await showProviderTemplates(host, ctx.reopen, snapshot.saved)) ? "stop" : "again";
			else if (choice.id === EXTERNAL_ROW) {
				const entries = externalAgentSignIns();
				const labels = entries.map((entry) => `${entry.name} — ${entry.detail}`);
				const picked = await host.showSelectorDialog("Add an external agent CLI", labels);
				const entry = picked ? entries[labels.indexOf(picked)] : undefined;
				if (entry) result = await openRunner(entry.id);
			} else if (choice.id === TEST_ALL_ROW) {
				await testAllProviders(host);
			} else if (choice.id === ADVANCED_ROW)
				result = await showSourcesPage(ctx, snapshot.saved, options.sourceEnvironment);
			else if (kind === "models") result = await showSourcesPage(ctx, snapshot.saved, options.sourceEnvironment);
			else if (kind === "provider") {
				const entry = snapshot.entry(key);
				if (choice.key) setProviderEnabled(host, key, entry?.name ?? key, isProviderDisabled(host, key));
				else {
					// A ready provider opens on its model chooser; closing it lands on the provider's page.
					if (entry?.state === "ready" && runtime.getModels(key).length > 0)
						await chooseProviderModels(host, key, entry.name);
					result = await showProviderDetail(ctx, key, refresh);
				}
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
