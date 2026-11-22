import { providerFallbackDirs } from "../../../config.ts";
import type { CredentialInfo } from "@octocodeai/octocode-ai";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { listPiProviderCredentials } from "../../../core/auth-storage/pi.ts";
import {
	applyProviderSources,
	describeProviderSources,
	detectLocalTools,
} from "../../../core/provider-sources/index.ts";
import { type CustomModelsFile, customModelsFiles } from "../../../core/provider-sources/models-files.ts";
import type {
	DetectedTool,
	ProviderSource,
	ProviderSourceEnvironment,
	ToggleableSourceId,
} from "../../../core/provider-sources/types.ts";
import type { PageRow } from "../../../theme/manage-page.ts";
import { badge } from "../../../theme/page-kit.ts";
import type { PageResult } from "./provider-detail.ts";
import { piConfigDirs, showPiProviders } from "./provider-pi.ts";
import { type PageContext, signInToProvider } from "./provider-signin.ts";
import { showPage, successNotice } from "./provider-ui.ts";

/** Everything the sources, detected-tool and custom-models sections show. Paths and names only, never a credential. */
interface SourcesView {
	sources: ProviderSource[];
	tools: DetectedTool[];
	files: CustomModelsFile[];
}

async function loadSourcesView(ctx: PageContext, environment?: ProviderSourceEnvironment): Promise<SourcesView> {
	const { settingsManager } = ctx.host.session;
	const ownDir = ctx.host.session.modelRuntime.getConfigurationDirectory();
	const piDirs =
		environment?.piDirs ?? (ownDir ? providerFallbackDirs(ownDir, environment?.home, environment?.env) : []);
	const sources = describeProviderSources(settingsManager.getProviderSources(), {
		...environment,
		agentDir: ownDir,
		piDirs,
	});
	const piOn = sources.find((source) => source.id === "pi")?.state.enabled ?? true;
	return {
		sources,
		tools: detectLocalTools(environment),
		files: await customModelsFiles({ ownDir, piDirs }, piOn, environment?.env),
	};
}

const sourceRowId = (id: string): string => `source:${id}`;
const toolRowId = (id: string): string => `tool:${id}`;
const fileRowId = (index: number): string => `models:${index}`;

function sourceRow(source: ProviderSource): PageRow {
	const shown = source.paths.slice(0, 2).join(", ");
	return {
		id: sourceRowId(source.id),
		name: source.label,
		detail: source.paths.length > 2 ? `${shown}, …` : shown,
		badge: badge(source.state.enabled ? "ready" : "off").text,
		tone: badge(source.state.enabled ? "ready" : "off").tone,
		...(source.toggleable ? { keys: { e: source.state.enabled ? "turn off" : "turn on" } } : {}),
	};
}

/** What a detected tool's row offers, in words: Octocode's own sign-in or an API key. */
function toolActionText(ctx: PageContext, tool: DetectedTool): string {
	const name = ctx.host.session.modelRuntime.getProvider(tool.action.providerId)?.name ?? tool.action.providerId;
	return tool.action.kind === "sign-in" ? `sign in with ${name}` : `add an API key for ${name}`;
}

function toolRow(ctx: PageContext, tool: DetectedTool): PageRow {
	return {
		id: toolRowId(tool.id),
		name: tool.label,
		detail: `${tool.foundAt[0] ?? ""} → ${toolActionText(ctx, tool)}`,
	};
}

function fileRow(file: CustomModelsFile, index: number): PageRow {
	const defines = file.defines.length ? ` · defines ${file.defines.join(", ")}` : "";
	return {
		id: fileRowId(index),
		name: `${file.origin} models.json`,
		detail: `${file.path}${defines}`,
		...(file.unreadable
			? {
					badge: badge("broken").text,
					tone: badge("broken").tone,
					detail: `${file.path} · unreadable; fix or remove the file`,
				}
			: file.exists
				? {}
				: { badge: badge("off").text, tone: badge("off").tone, detail: `${file.path} · not found` }),
	};
}

/** File-level diagnostics are separate from everyday provider access. */
export async function showSourcesPage(
	ctx: PageContext,
	saved: readonly CredentialInfo[],
	environment?: ProviderSourceEnvironment,
): Promise<PageResult> {
	let initialId: string | undefined;
	for (;;) {
		const view = await loadSourcesView(ctx, environment);
		const choice = await showPage(ctx.host, {
			title: "Provider sources and custom models",
			initialId,
			sections: [
				{ heading: "Sources", rows: view.sources.map(sourceRow) },
				{
					heading: "Detected tools",
					rows: view.tools.map((tool) => toolRow(ctx, tool)),
					empty: "no other tools found",
				},
				{ heading: "Custom models", rows: view.files.map(fileRow) },
			],
			nested: true,
		});
		if (!choice) return "again";
		initialId = choice.id;
		const [kind, ...parts] = choice.id.split(":");
		const key = parts.join(":");
		if (kind === "source") {
			const source = view.sources.find((entry) => entry.id === key);
			if (source && choice.key) {
				if (source.toggleable) await toggleSource(ctx, source, !source.state.enabled);
			} else if (source && (await showSourceDetail(ctx, source, view.files)) === "stop") return "stop";
		} else if (kind === "tool" && !choice.key) {
			const tool = view.tools.find((entry) => entry.id === key);
			if (tool && (await runToolAction(ctx, tool, saved)) === "stop") return "stop";
		} else if (kind === "models" && !choice.key) {
			const file = view.files[Number(key)];
			if (file && choice.id === fileRowId(Number(key)))
				ctx.host.showStatus(
					`${file.origin} models.json: ${file.path}${file.exists ? "" : " (not found; create it to define providers)"}. Edit it, then open /model to refresh models. See docs/models.md.`,
				);
		}
	}
}

/** Turn a toggleable source on or off, recompute what the runtime offers and say so. No file is touched. */
async function toggleSource(ctx: PageContext, source: ProviderSource, enabled: boolean): Promise<void> {
	const { host } = ctx;
	const { settingsManager, modelRuntime } = host.session;
	try {
		settingsManager.setProviderSourceEnabled(source.id as ToggleableSourceId, enabled);
		await applyProviderSources(modelRuntime, settingsManager.getProviderSources());
		host.updateAvailableProviderCount();
		host.showStatus(successNotice(enabled ? "Turned on" : "Turned off", source.label, "Files are unchanged."));
	} catch (error) {
		host.showError(`Could not change ${source.label}: ${errorMessage(error)}`);
	}
}

/** A detected tool's action: Octocode's own sign-in for its account, or API-key entry. Nothing is read from the tool. */
async function runToolAction(
	ctx: PageContext,
	tool: DetectedTool,
	saved: readonly CredentialInfo[],
): Promise<PageResult> {
	try {
		const prefer = tool.action.kind === "sign-in" ? "oauth" : "api_key";
		const opened = await signInToProvider(ctx, tool.action.providerId, saved, prefer);
		return opened ? "stop" : "again";
	} catch (error) {
		ctx.host.showError(errorMessage(error));
		return "again";
	}
}

const IMPORT_LABEL = "Import a sign-in into Octocode";

/** One source's page: its state and files, then turn it on or off and, for Pi, import a saved sign-in. */
async function showSourceDetail(
	ctx: PageContext,
	source: ProviderSource,
	files: readonly CustomModelsFile[],
): Promise<PageResult> {
	const { host } = ctx;
	const actions = new Map<string, () => void | Promise<void>>();
	if (source.toggleable) {
		const label = source.state.enabled ? "Turn off" : "Turn on";
		actions.set(label, () => toggleSource(ctx, source, !source.state.enabled));
	}
	const facts = [
		{
			label: "Status",
			value: source.toggleable
				? `${source.state.enabled ? "on" : "off"}${source.state.overridden ? "" : " (default)"}`
				: "on (always)",
		},
		{ label: "Gives", value: source.provides.join(" and ") },
		{ label: "Reads", value: source.paths.join(", ") },
		{ label: "Found", value: source.state.present ? "yes" : "nothing there yet" },
	];
	if (source.id === "pi") {
		const defines = files.filter((file) => file.origin === "Pi").flatMap((file) => file.defines);
		facts.push({ label: "Defines", value: defines.length ? defines.join(", ") : "no providers" });
		if (source.state.enabled) {
			try {
				const signIns = await listPiProviderCredentials(piConfigDirs(host));
				facts.push({ label: "Sign-ins", value: `${signIns.length} saved in Pi auth.json (read only)` });
			} catch (error) {
				host.showError(errorMessage(error));
			}
			actions.set(IMPORT_LABEL, async () => {
				await showPiProviders(host, async (id) => ctx.reopen(id));
			});
		}
	}
	const choice = await showPage(host, {
		title: `${source.label} — source`,
		facts,
		sections: [
			{
				heading: "ACTIONS",
				rows: [...actions.keys()].map((label) => ({ id: label, name: label })),
				empty: source.toggleable ? undefined : `${source.label} is ours and always on.`,
			},
		],
		nested: true,
	});
	const run = choice ? actions.get(choice.id) : undefined;
	if (!run) return "again";
	await run();
	return choice?.id === IMPORT_LABEL ? "stop" : "again";
}
