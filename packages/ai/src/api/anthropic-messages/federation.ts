import type * as NodeFsPromises from "node:fs/promises";
import type { Model, ProviderEnv, ProviderHeaders } from "../../types.ts";
import { hasProviderHeader } from "../../utils/headers.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { getUserAgent } from "../../utils/user-agent.ts";

const NODE_FS_PROMISES = "node:fs/promises";
import { redactProviderText } from "../../utils/error-body.ts";

interface Federation {
	organization_id: string;
	workspace_id?: string;
	authentication: {
		type: "oidc_federation";
		federation_rule_id: string;
		service_account_id?: string;
		identity_token: { source: "file"; path: string };
	};
}
function hasAuth(apiKey: string | undefined, headers: ProviderHeaders | undefined): boolean {
	return (
		!!apiKey || ["authorization", "x-api-key", "cf-aig-authorization"].some((name) => hasProviderHeader(headers, name))
	);
}
export function assertRequestAuth(
	provider: string,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): void {
	if (!hasAuth(apiKey, headers)) throw new Error(`No API key for provider: ${provider}`);
}
export function getAnthropicFederation(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
	env: ProviderEnv | undefined,
): Federation | undefined {
	if (model.provider !== "anthropic" || hasAuth(apiKey, { ...model.headers, ...headers })) return undefined;
	const rule = getProviderEnvValue("ANTHROPIC_FEDERATION_RULE_ID", env);
	const organization = getProviderEnvValue("ANTHROPIC_ORGANIZATION_ID", env);
	const file = getProviderEnvValue("ANTHROPIC_IDENTITY_TOKEN_FILE", env);
	if (!rule || !organization || !file) return undefined;
	return {
		organization_id: organization,
		workspace_id: getProviderEnvValue("ANTHROPIC_WORKSPACE_ID", env),
		authentication: {
			type: "oidc_federation",
			federation_rule_id: rule,
			service_account_id: getProviderEnvValue("ANTHROPIC_SERVICE_ACCOUNT_ID", env),
			identity_token: { source: "file", path: file },
		},
	};
}
const credentialFetches = new WeakMap<typeof globalThis.fetch, typeof globalThis.fetch>();
export function registerCredentialFetch(wrapper: typeof globalThis.fetch, original: typeof globalThis.fetch): void {
	credentialFetches.set(wrapper, original);
}
export function originalCredentialFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return credentialFetches.get(fetch) ?? fetch;
}
async function tokenBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks).toString("utf8");
			size += value.byteLength;
			if (size > 1024 * 1024) throw new Error("Anthropic token response exceeds 1 MiB");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
interface Token {
	token: string;
	expiresAt: number;
}
let cache:
	| { key: string; fetch: typeof globalThis.fetch; value?: Token; pending?: Promise<Token>; lastError?: number }
	| undefined;
export function federationToken(
	model: Model<"anthropic-messages">,
	config: Federation,
	fetch: typeof globalThis.fetch,
): () => Promise<string> {
	const base = model.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
	const endpoint = new URL(`${base}/v1/oauth/token`);
	if (
		endpoint.protocol !== "https:" &&
		!(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
	)
		throw new Error("Anthropic federation requires a secure token endpoint");
	const key = JSON.stringify([base, config]);
	if (cache?.key !== key || cache.fetch !== fetch) cache = { key, fetch };
	const state = cache;
	const refresh = () => {
		if (state.pending) return state.pending;
		state.pending = (async (): Promise<Token> => {
			// Federation reads a token file and is Node only: a variable specifier keeps node:fs out of browser bundles.
			const { open } = (await import(NODE_FS_PROMISES)) as typeof NodeFsPromises;
			const file = await open(config.authentication.identity_token.path, "r");
			let assertion: string;
			try {
				const buffer = Buffer.alloc(16 * 1024 + 1);
				const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
				if (bytesRead > 16 * 1024) throw new Error("Anthropic identity token exceeds the 16 KiB assertion limit");
				assertion = buffer.subarray(0, bytesRead).toString("utf8").trim();
			} finally {
				await file.close();
			}
			const response = await fetch(endpoint.href, {
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
				headers: {
					"content-type": "application/json",
					"User-Agent": getUserAgent(),
					"anthropic-beta": "oauth-2025-04-20,oidc-federation-2026-04-01",
				},
				body: JSON.stringify({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion,
					federation_rule_id: config.authentication.federation_rule_id,
					organization_id: config.organization_id,
					...(config.authentication.service_account_id
						? { service_account_id: config.authentication.service_account_id }
						: {}),
					...(config.workspace_id ? { workspace_id: config.workspace_id } : {}),
				}),
			});
			const text = await tokenBody(response);
			if (!response.ok)
				throw new Error(`Anthropic token exchange failed with status ${response.status}: ${redactProviderText(text)}`);
			const data = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
			if (data.token_type && (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer"))
				throw new Error("Anthropic token endpoint returned an unsupported token type");
			const expires = Number(data.expires_in);
			if (typeof data.access_token !== "string" || !data.access_token || !Number.isFinite(expires))
				throw new Error("Anthropic token endpoint response missing required fields");
			const token = { token: data.access_token, expiresAt: Date.now() + expires * 1000 };
			state.value = token;
			return token;
		})().finally(() => {
			state.pending = undefined;
		});
		return state.pending;
	};
	return async () => {
		const remaining = state.value ? state.value.expiresAt - Date.now() : 0;
		if (state.value && remaining > 30_000) {
			if (remaining <= 120_000 && Date.now() - (state.lastError ?? 0) >= 5_000)
				void refresh().catch(() => {
					state.lastError = Date.now();
				});
			return state.value.token;
		}
		return (await refresh()).token;
	};
}
