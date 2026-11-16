import type { GatewayOptions } from "./gateway.ts";

export interface Tier {
	name: string;
	baseUrl: string;
	model: string;
	api: "openai" | "anthropic";
	key?: string;
	/** Chat-body fields that switch model thinking off (local models only). */
	body: Record<string, unknown>;
	/** Paid tiers run with bounded concurrency; local ones run one call at a time. */
	remote: boolean;
	/** Per-call timeout. */
	timeoutMs: number;
}

export type TierResolution = { tier: Tier } | { skip: string };

const PRESETS: Record<string, Omit<Tier, "name" | "key" | "baseUrl" | "model"> & { baseUrl?: string; model: string }> =
	{
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

/**
 * Resolve the tier named by TESTKIT_TIER from TESTKIT_<TIER>_BASE_URL / _KEY / _MODEL.
 * `local` defaults to Ollama; paid tiers need a base URL and key. Never throws: a missing piece is a skip reason.
 * TESTKIT_OLLAMA=1 alone still selects `local`.
 */
export function resolveTier(env: Record<string, string | undefined> = process.env): TierResolution {
	const name = (env.TESTKIT_TIER ?? (env.TESTKIT_OLLAMA === "1" ? "local" : "")).toLowerCase();
	if (!name) return { skip: "no tier: set TESTKIT_TIER (local, haiku or deepseek)" };
	const p = PRESETS[name];
	if (!p) return { skip: `unknown tier "${name}" (known: ${TIER_NAMES.join(", ")})` };
	const pre = `TESTKIT_${name.toUpperCase()}_`;
	const baseUrl = env[`${pre}BASE_URL`] ?? (name === "local" ? (env.TESTKIT_OLLAMA_URL ?? p.baseUrl) : p.baseUrl);
	const key = env[`${pre}KEY`];
	if (!baseUrl) return { skip: `tier ${name}: set ${pre}BASE_URL` };
	if (p.remote && !key) return { skip: `tier ${name}: set ${pre}KEY` };
	const model = env[`${pre}MODEL`] ?? (name === "local" ? (env.TESTKIT_OLLAMA_MODEL ?? p.model) : p.model);
	const { baseUrl: _unused, ...rest } = p;
	void _unused;
	return { tier: { ...rest, name, baseUrl, model, key } };
}

/** Gateway `forward` options for a tier. */
export function forwardOf(t: Tier): NonNullable<GatewayOptions["forward"]> {
	return { baseUrl: t.baseUrl, model: t.model, api: t.api, key: t.key, timeoutMs: t.timeoutMs };
}
