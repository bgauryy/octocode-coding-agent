import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { octocodecodeAdapter } from "../../../src/adapters/octocodecode/index.ts";
import type { AgentRun, ProbeProvider } from "../cache-probe.ts";

export const MODELS_JSON =
	process.env.TESTKIT_LIVE_MODELS_JSON ?? join(homedir(), ".octocode", "octocodecode", "models.json");

/** Resolve a `models.json` apiKey the way Octocode does for literals and `$NAME`; `!command` keys are not run. */
function resolveKey(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw || raw.startsWith("!")) return undefined;
	const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
	return ref ? process.env[ref[1]] : raw;
}

/** A provider's endpoint and model entry from the user's `models.json`, or the reason it is unusable. */
export function loadProvider(id: string, modelId: string): ProbeProvider | string {
	if (!existsSync(MODELS_JSON)) return `no ${MODELS_JSON}`;
	const cfg = JSON.parse(readFileSync(MODELS_JSON, "utf8")) as {
		providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: unknown; models?: { id: string }[] }>;
	};
	const p = cfg.providers?.[id];
	if (!p?.baseUrl || !p.api) return `provider ${id} missing baseUrl/api`;
	const model = p.models?.find((m) => m.id === modelId);
	if (!model) return `provider ${id} lists no model ${modelId}`;
	const key = resolveKey(p.apiKey);
	if (!key) return `provider ${id}: no usable apiKey (literal or $NAME)`;
	return { id, api: p.api, upstreamBase: p.baseUrl, model: { ...model }, key };
}

export interface McpServerConfig {
	url: string;
	toolExposure?: Record<string, string>;
	description?: string;
}

export interface ScenarioRun {
	bundle: string;
	provider: ProbeProvider;
	baseUrl: string;
	prompts: string[];
	mcpServers?: Record<string, McpServerConfig>;
	/** Skills written under the agent home: name → SKILL.md text. */
	skills?: Record<string, string>;
	/** `settings.json` of the agent home. */
	settings?: Record<string, unknown>;
	/** Files written into the workspace: relative path → text. */
	files?: Record<string, string>;
	timeoutMs?: number;
}

/** Runs the real bundle once in an isolated HOME and workspace; one session, one prompt per turn. */
export async function runScenario(opts: ScenarioRun): Promise<AgentRun> {
	const p = opts.provider;
	const servers = Object.entries(opts.mcpServers ?? {});
	const session = await octocodecodeAdapter({
		bundle: opts.bundle,
		provider: { id: p.id, api: p.api, model: p.model, baseUrl: opts.baseUrl, key: p.key },
		thinking: "off",
		persistSession: true,
		skills: opts.skills,
		settings: opts.settings,
		files: opts.files,
		mcp: Object.fromEntries(servers.map(([name, { url: _url, ...config }]) => [name, config])),
	}).start({
		gatewayUrl: opts.baseUrl,
		mcpUrls: Object.fromEntries(servers.map(([name, { url }]) => [name, url])),
	});
	try {
		const r = await session.run({ prompts: opts.prompts, timeoutMs: opts.timeoutMs ?? 240_000 });
		return { exitCode: r.exitCode, timedOut: r.timedOut, stderr: r.stderr, events: r.events };
	} finally {
		await session.close();
	}
}
