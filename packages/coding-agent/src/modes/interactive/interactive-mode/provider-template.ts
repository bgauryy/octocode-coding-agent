import { join } from "node:path";
import { homeTilde } from "../../../../../common/src/home-tilde.ts";
import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { vendorChatModels } from "../../../core/provider-composer/known-models.ts";
import {
	addTemplateProvider,
	freeProviderId,
	type TemplateKey,
	templateBaseUrl,
	templateProviderEntry,
} from "../../../core/provider-templates/apply.ts";
import {
	type ListedModel,
	type TemplateModel,
	type TemplateModelSources,
	templateModelEntries,
	templateModels,
} from "../../../core/provider-templates/models.ts";
import { PROVIDER_TEMPLATES, type ProviderTemplate } from "../../../core/provider-templates/templates.ts";
import { type Catalog, loadCatalog, modelsDevEnabled } from "../../../octocode/subagents/catalog.ts";
import type { ModelsJsonModel } from "../../../core/model-config.ts";
import { parseContextSize } from "../../../utils/token-count.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { successNotice } from "./provider-ui.ts";

/** What the template flow uses of the interactive host. */
type TemplateHost = Pick<
	ProviderManagerHost,
	| "session"
	| "showExtensionSelector"
	| "showExtensionInput"
	| "showApiKeyLoginDialog"
	| "showStatus"
	| "showError"
	| "updateAvailableProviderCount"
>;

const API_NAMES: Record<string, string> = {
	"openai-completions": "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic Messages",
	"google-generative-ai": "Google Gemini",
};

function templateLabel(template: ProviderTemplate): string {
	const api = API_NAMES[template.api] ?? template.api;
	const where = template.baseUrl
		? new URL(template.baseUrl).host
		: template.kind === "local"
			? "local server"
			: "your host";
	return `${template.name} — ${where} · ${api}`;
}

/** The models.dev listing of one provider, from the saved index (refreshed when stale; off with OCTOCODE_MODELS_DEV=0). */
function catalogListing(catalog: Catalog | undefined): (provider: string) => ListedModel[] {
	return (provider) =>
		Object.entries(catalog?.models ?? {})
			.filter(([key]) => key.startsWith(`${provider}/`))
			.map(([key, model]) => ({ ...model, id: key.slice(provider.length + 1) }));
}

const contextText = (model: TemplateModel) =>
	model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k context` : "";

/** The model ids to add: all offered, one picked from the list, or typed. Undefined when the user cancels. */
async function chooseModels(ui: TemplateHost, template: ProviderTemplate, offered: readonly TemplateModel[]) {
	const typeIds = "Type model ids…";
	const pickOne = "Pick one model…";
	const all = `All ${offered.length} known models`;
	const choice = offered.length
		? await ui.showExtensionSelector(`Models for ${template.name}`, [all, pickOne, typeIds])
		: typeIds;
	if (!choice) return undefined;
	if (choice === all) return offered.map((model) => model.id);
	if (choice === pickOne) {
		const labels = offered.map((model) => `${model.id}${contextText(model)}`);
		const picked = await ui.showExtensionSelector(`Model for ${template.name}`, labels);
		return picked ? [offered[labels.indexOf(picked)].id] : undefined;
	}
	const examples = offered.length ? offered.slice(0, 2).map((model) => model.id) : ["model-id"];
	const typed = await ui.showExtensionInput(
		`Model ids for ${template.name}, comma-separated (as the server names them)`,
		examples.join(", "),
	);
	const ids = typed
		?.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	return ids?.length ? ids : undefined;
}

/** Where the key comes from. Undefined when the user cancels. */
async function chooseKey(ui: TemplateHost, template: ProviderTemplate): Promise<TemplateKey | undefined> {
	const options = new Map<string, TemplateKey>();
	if (template.key === "optional") options.set("No key — the server runs without one", { kind: "none" });
	options.set("Save a key in Octocode (asked next)", { kind: "saved" });
	if (template.keyEnv) {
		const set = process.env[template.keyEnv] ? " (set now)" : "";
		options.set(`Read $${template.keyEnv} from the environment${set}`, { kind: "env", name: template.keyEnv });
	}
	const named = "Read an environment variable you name…";
	const labels = [...options.keys(), named];
	const picked = await ui.showExtensionSelector(`Key for ${template.name}`, labels);
	if (picked !== named) return picked ? options.get(picked) : undefined;
	const name = (await ui.showExtensionInput("Environment variable that holds the key", "GATEWAY_API_KEY"))?.trim();
	return name ? { kind: "env", name: name.replace(/^\$/, "") } : undefined;
}

async function chooseTokenLimit(ui: TemplateHost, title: string, maximum?: number): Promise<number | undefined> {
	for (;;) {
		const answer = await ui.showExtensionInput(title, "Tokens, for example 8192 or 8k");
		if (answer === undefined) return undefined;
		const tokens = parseContextSize(answer);
		if (tokens !== undefined && (maximum === undefined || tokens <= maximum)) return tokens;
		ui.showError(
			maximum === undefined
				? "Enter a positive whole number of tokens matching your server's configuration."
				: `Maximum output must be a positive whole number no greater than the ${maximum} token context window.`,
		);
	}
}

async function chooseLocalLimits(ui: TemplateHost, models: ModelsJsonModel[]): Promise<ModelsJsonModel[] | undefined> {
	const configured: ModelsJsonModel[] = [];
	for (const model of models) {
		const contextWindow = await chooseTokenLimit(ui, `${model.id}: context window (match the loaded server setting)`);
		if (contextWindow === undefined) return undefined;
		const maxTokens = await chooseTokenLimit(ui, `${model.id}: maximum output tokens`, contextWindow);
		if (maxTokens === undefined) return undefined;
		configured.push({ ...model, contextWindow, maxTokens });
	}
	return configured;
}

/**
 * `/providers` → `Add from a template`: pick a template, give the host when it has none, pick model ids and where the
 * key comes from. The entry is added to the global models.json (never with a key in it); a saved key goes to auth.json
 * through the provider's own API-key sign-in. Returns true when the flow moved on to another page.
 */
export async function showProviderTemplates(
	ui: TemplateHost,
	reopen: (providerId: string) => void,
	saved: readonly CredentialInfo[],
): Promise<boolean> {
	const runtime = ui.session.modelRuntime;
	const labels = PROVIDER_TEMPLATES.map(templateLabel);
	const label = await ui.showExtensionSelector("Add a provider from a template", labels);
	const template = label ? PROVIDER_TEMPLATES[labels.indexOf(label)] : undefined;
	const cancelled = (): false => {
		ui.showStatus("Cancelled; nothing was written to models.json.");
		return false;
	};
	if (!template) return cancelled();
	let serverHost: string | undefined;
	if (!template.baseUrl) {
		const hint = template.hostDefault ? `${template.hostHint} (Enter keeps it)` : template.hostHint;
		serverHost = await ui.showExtensionInput(`${template.name}: API base URL`, hint);
		if (serverHost === undefined) return cancelled();
		try {
			templateBaseUrl(template, serverHost);
		} catch (error) {
			ui.showError(errorMessage(error));
			return false;
		}
	}
	const catalog = template.catalog && modelsDevEnabled() ? await loadCatalog() : undefined;
	const sources: TemplateModelSources = {
		// The built-in models, the same ones a bare id inherits from when models.json loads.
		vendorModels: (api) => vendorChatModels({ get: (id) => runtime.getBuiltinProvider(id) }, api),
		listed: catalogListing(catalog),
	};
	const ids = await chooseModels(ui, template, templateModels(template, sources));
	if (!ids) return cancelled();
	let models = templateModelEntries(template, ids, sources);
	if (template.kind === "local") {
		const configured = await chooseLocalLimits(ui, models);
		if (!configured) return cancelled();
		models = configured;
	}
	const key = await chooseKey(ui, template);
	if (!key) return cancelled();
	const directory = runtime.getConfigurationDirectory();
	if (!directory) {
		ui.showError("This session has no Octocode configuration folder, so there is no models.json to add to.");
		return false;
	}
	const taken = new Set([...runtime.getProviders().map((provider) => provider.id), ...saved.map((s) => s.providerId)]);
	const id = freeProviderId(template.id, taken);
	try {
		await addTemplateProvider(
			join(directory, "models.json"),
			id,
			templateProviderEntry(template, { host: serverHost, key, models }),
		);
		await runtime.refresh({ allowNetwork: false });
		ui.updateAvailableProviderCount();
	} catch (error) {
		ui.showError(errorMessage(error));
		return false;
	}
	const name = runtime.getProvider(id)?.name ?? template.name;
	if (key.kind === "saved") {
		await ui.showApiKeyLoginDialog(id, name, () => reopen(id));
		// Leaving the key dialog without saving a key keeps the provider that was already written.
		if (!runtime.getProviderAuthStatus(id).configured) {
			ui.showStatus(
				`${name} was added to ${homeTilde(join(directory, "models.json"))} without a key. It shows under Needs attention in /providers; add a key there or set its environment variable.`,
			);
		}
		return true;
	}
	const count = `${ids.length} ${ids.length === 1 ? "model" : "models"}`;
	const unset = key.kind === "env" && !process.env[key.name] ? `Set $${key.name} where you start Octocode, then ` : "";
	ui.showStatus(successNotice("Added", `${name} (${id}, ${count})`, `${unset}pick a model with /model.`));
	reopen(id);
	return true;
}
