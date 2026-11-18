import type { GatewayOptions } from "./gateway.ts";

export interface Tier {
	name: string;
	baseUrl: string;
	model: string;
	/** `responses` forwards Responses clients as sent; judges and simulated users need `openai` or `anthropic`. */
	api: "openai" | "anthropic" | "responses";
	key?: string;
	/** Fields merged into every upstream request (`Forward.body`), such as `reasoning_effort: "none"` for the local preset. */
	body: Record<string, unknown>;
	/** Paid tiers run with bounded concurrency; local ones run one call at a time. */
	remote: boolean;
	/** Per-call timeout. */
	timeoutMs: number;
}

export type TierResolution = { tier: Tier } | { skip: string };

type Preset = Omit<Tier, "name" | "key" | "baseUrl" | "model"> & { baseUrl?: string; model: string };

const PRESETS: Record<string, Preset> = {
	local: {
		baseUrl: "http://localhost:11434/v1",
		model: "bonsai-2:9b",
		api: "openai",
		body: { reasoning_effort: "none" },
		remote: false,
		timeoutMs: 90_000,
	},
	haiku: { model: "claude-haiku-5-5", api: "anthropic", body: {}, remote: true, timeoutMs: 90_000 },
	deepseek: { model: "DeepSeek-V4-Flash", api: "anthropic", body: {}, remote: true, timeoutMs: 120_000 },
};

const TIER_NAMES = Object.keys(PRESETS);
const API_VALUES: readonly Tier["api"][] = ["openai", "anthropic", "responses"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** Timeout of a custom tier that does not set TESTKIT_<NAME>_TIMEOUT_MS. */
const CUSTOM_TIMEOUT_MS = 90_000;

const hostOf = (baseUrl: string): string | undefined => {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
};

/**
 * Resolve the tier named by TESTKIT_TIER. A preset (`local`, `haiku`, `deepseek`) reads TESTKIT_<NAME>_BASE_URL / _KEY /
 * _MODEL / _API. Any other name is a custom tier that needs _BASE_URL and _MODEL; it is remote unless the host is
 * localhost, 127.0.0.1 or ::1, and a remote tier needs _KEY. _API is `openai` (default), `anthropic` or `responses`; a custom
 * tier's _TIMEOUT_MS defaults to 90000. Names are case-insensitive; non-alphanumerics in the name become `_` in the
 * variable names. `local` defaults to Ollama; TESTKIT_OLLAMA=1 alone still selects `local`.
 * Never throws: a missing or invalid piece is a skip reason.
 */
export function resolveTier(env: Record<string, string | undefined> = process.env): TierResolution {
	const name = (env.TESTKIT_TIER ?? (env.TESTKIT_OLLAMA === "1" ? "local" : "")).trim().toLowerCase();
	if (!name) return { skip: "no tier: set TESTKIT_TIER (local, haiku, deepseek or a custom name)" };
	const preset = Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;
	const pre = `TESTKIT_${name.replace(/[^a-z0-9]/g, "_").toUpperCase()}_`;
	const get = (suffix: string): string | undefined => env[`${pre}${suffix}`] || undefined;
	const apiRaw = get("API");
	const api = apiRaw === undefined ? undefined : API_VALUES.find((a) => a === apiRaw);
	if (apiRaw !== undefined && api === undefined)
		return { skip: `tier ${name}: ${pre}API must be openai, anthropic or responses, got "${apiRaw}"` };
	const ollama = name === "local";
	const baseUrl = get("BASE_URL") ?? (ollama ? env.TESTKIT_OLLAMA_URL || undefined : undefined) ?? preset?.baseUrl;
	const model = get("MODEL") ?? (ollama ? env.TESTKIT_OLLAMA_MODEL || undefined : undefined) ?? preset?.model;
	if (!baseUrl || !model) {
		const missing = [!baseUrl && `${pre}BASE_URL`, !model && `${pre}MODEL`].filter((v): v is string => Boolean(v));
		return {
			skip: preset
				? `tier ${name}: set ${missing.join(", ")}`
				: `unknown tier "${name}" (presets: ${TIER_NAMES.join(", ")}): set ${missing.join(", ")}`,
		};
	}
	const host = hostOf(baseUrl);
	if (host === undefined) return { skip: `tier ${name}: ${pre}BASE_URL is not a URL: ${baseUrl}` };
	const remote = preset ? preset.remote : !LOCAL_HOSTS.has(host);
	const key = get("KEY");
	if (remote && !key) return { skip: `tier ${name}: set ${pre}KEY` };
	const timeoutRaw = get("TIMEOUT_MS");
	const timeoutMs = preset ? preset.timeoutMs : Number(timeoutRaw ?? CUSTOM_TIMEOUT_MS);
	if (!preset && !(Number.isInteger(timeoutMs) && timeoutMs > 0))
		return { skip: `tier ${name}: ${pre}TIMEOUT_MS must be a positive integer, got "${timeoutRaw}"` };
	return {
		tier: {
			name,
			baseUrl,
			model,
			api: api ?? preset?.api ?? "openai",
			key,
			body: preset?.body ?? {},
			remote,
			timeoutMs,
		},
	};
}

/** Gateway `forward` options for a tier. */
export function forwardOf(t: Tier): NonNullable<GatewayOptions["forward"]> {
	return {
		baseUrl: t.baseUrl,
		model: t.model,
		api: t.api,
		key: t.key,
		timeoutMs: t.timeoutMs,
		...(Object.keys(t.body).length ? { body: t.body } : {}),
	};
}
