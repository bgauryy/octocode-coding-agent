import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { describeProviderSources } from "../../../core/provider-sources/index.ts";
import type { ProviderSourceEnvironment } from "../../../core/provider-sources/types.ts";
import { keyText } from "../components/keybinding-hints.ts";
import type { PageRow, PageSection } from "../components/manage-page.ts";
import { credentialSource, isProviderDisabled, modelCount, setProviderEnabled } from "./provider-actions.ts";
import { showProviderDetail } from "./provider-detail.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { showPiProviders } from "./provider-pi.ts";
import { type PageContext, showSignIn } from "./provider-signin.ts";
import {
	fileRow,
	fileRowId,
	loadSourcesView,
	runToolAction,
	showSourceDetail,
	sourceRow,
	toggleSource,
	toolRow,
} from "./provider-sources-page.ts";
import { showPage } from "./provider-ui.ts";

const SIGN_IN_ROW = "signin";
const providerRowId = (id: string): string => `provider:${id}`;

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
			host.showStatus("The Pi source is off. Turn it on in /providers (Sources) to use its providers and sign-ins.");
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
		const runtime = host.session.modelRuntime;
		const ids = new Set([
			...runtime.getProviders().map((provider) => provider.id),
			...saved.map((entry) => entry.providerId),
		]);
		const nameOf = (id: string) => runtime.getProvider(id)?.name ?? id;
		if (wanted && initialId === undefined) {
			const exact = [...ids].find((id) => [id, nameOf(id)].some((value) => value.toLowerCase() === wanted));
			if (exact) {
				await showProviderDetail(ctx, exact, saved);
				return;
			}
			await showSignIn(ctx, saved, query);
			return;
		}
		const view = await loadSourcesView(ctx, options.sourceEnvironment);
		// The kind of every signed-in provider, resolved before the rows are built; a key is inspected, never shown.
		const kinds = new Map<string, string>();
		await Promise.all(
			[...ids]
				.filter((id) => runtime.getProviderAuthStatus(id).configured)
				.map(async (id) => kinds.set(id, await runtime.getCredentialKind(id, AbortSignal.timeout(15_000)))),
		);
		const providerRows = (disabled: boolean): PageRow[] =>
			[...ids]
				.filter((id) => isProviderDisabled(host, id) === disabled)
				.filter((id) => disabled || runtime.hasConfiguredAuth(id) || saved.some((entry) => entry.providerId === id))
				.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
				.map((id) => {
					const configured = runtime.getProviderAuthStatus(id).configured;
					const method = kinds.get(id) ?? "key";
					const count = modelCount(host, id);
					// A saved credential outlives its provider when a models.json entry is removed or renamed.
					const state = !runtime.getProvider(id)
						? "saved credential · provider not defined (removed from models.json?)"
						: configured
							? `${method} · ${credentialSource(host, id)}`
							: saved.some((entry) => entry.providerId === id)
								? "saved credential could not be read"
								: "not configured";
					return {
						id: providerRowId(id),
						name: nameOf(id),
						detail: `${state} · ${count} ${count === 1 ? "model" : "models"}`,
						badge: disabled ? "disabled" : "enabled",
						tone: disabled ? ("muted" as const) : ("success" as const),
					};
				});
		const disabledRows = providerRows(true);
		const sections: PageSection[] = [
			{ heading: "Signed in", rows: providerRows(false), empty: "none yet — choose Sign in below" },
			...(disabledRows.length ? [{ heading: "Disabled", rows: disabledRows }] : []),
			{
				heading: "Sign in",
				rows: [{ id: SIGN_IN_ROW, name: "+ Add a provider", detail: "sign in with an account or an API key" }],
			},
			{ heading: "Sources", rows: view.sources.map(sourceRow) },
			{ heading: "Detected", rows: view.tools.map((tool) => toolRow(ctx, tool)), empty: "no other tools found" },
			{ heading: "Custom models", rows: view.files.map(fileRow) },
		];
		const choice = await showPage(host, {
			title: "AI providers — sign in, enable or disable providers, manage sources",
			notes: ["/model chooses a model · Configured means credentials are present; access is not verified."],
			sections,
			initialId,
			keys: ["e"],
			hints: [
				[keyText("tui.select.confirm"), "open", 0],
				["e", "enable/disable", 1],
				[keyText("tui.select.cancel"), "close", 2],
			],
		});
		if (!choice) return;
		initialId = choice.id;
		try {
			const [kind, ...rest] = choice.id.split(":");
			const key = rest.join(":");
			let result: "again" | "stop" = "again";
			if (choice.id === SIGN_IN_ROW) result = (await showSignIn(ctx, saved)) ? "stop" : "again";
			else if (kind === "provider") {
				if (choice.key) setProviderEnabled(host, key, nameOf(key), isProviderDisabled(host, key));
				else result = await showProviderDetail(ctx, key, saved);
			} else if (kind === "source") {
				const source = view.sources.find((entry) => entry.id === key);
				if (source && choice.key) {
					if (source.toggleable) await toggleSource(ctx, source, !source.state.enabled);
				} else if (source) result = await showSourceDetail(ctx, source, view.files);
			} else if (kind === "tool") {
				const tool = view.tools.find((entry) => entry.id === key);
				if (tool && !choice.key) result = await runToolAction(ctx, tool, saved);
			} else if (kind === "models") {
				const file = view.files[Number(key)];
				if (file && !choice.key && choice.id === fileRowId(Number(key))) {
					host.showStatus(
						`${file.origin} models.json: ${file.path}${file.exists ? "" : " (not found; create it to define providers)"}. Edit it, then open /model to refresh models (or restart). See docs/models.md.`,
					);
				}
			}
			if (result === "stop") return;
		} catch (error) {
			host.showError(errorMessage(error));
		}
	}
}
