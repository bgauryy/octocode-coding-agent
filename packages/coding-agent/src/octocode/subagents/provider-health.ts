import { randomUUID } from "node:crypto";
import type { Api, Model } from "@octocodeai/octocode-ai";
import { checkCredentialByList } from "@octocodeai/octocode-ai/providers/discovery";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { redactSecrets, sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { ModelRef } from "./model.ts";

/**
 * A provider refused the credential itself: 401/403, an invalid or expired key, or no credit. Narrower than the
 * report's MODEL_REFUSED, which also covers unknown models: a model-level refusal says nothing about the other models
 * of that provider.
 */
const CREDENTIAL_REFUSED =
	/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authenticat|api[ _-]?key|credential|expired|insufficient[ _](?:quota|credit|balance)|billing/i;
const CHECK_TIMEOUT_MS = 20_000;

export interface ProviderStatus {
	ok: boolean;
	at: number;
	/** `list`: the provider's model list answered (no inference); `check`: a tiny inference request; `run`: a subagent. */
	via: "run" | "check" | "list";
	detail?: string;
}

/** Provider error text reaches the model listing: credentials are redacted, nothing is cut. */
const clean = (text: string) => redactSecrets(sanitizeTerminalText(text)).replace(/\s+/g, " ").trim();

/** What this process last learned about each provider's credential; the latest run or check replaces older news. */
export class ProviderHealth {
	private readonly status = new Map<string, ProviderStatus>();

	/**
	 * A finished subagent run on `model` ("provider/id"; undefined when it ran on this session's model): success clears a
	 * refusal, a credential refusal marks the provider, other failures say nothing.
	 */
	noteRun(model: string | undefined, error?: string): void {
		const provider = model?.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
		if (!provider) return;
		if (!error) this.status.set(provider, { ok: true, at: Date.now(), via: "run" });
		else if (CREDENTIAL_REFUSED.test(error))
			this.status.set(provider, { ok: false, at: Date.now(), via: "run", detail: clean(error) });
	}

	/** A live check: any failure counts, since the request was the smallest one the provider accepts. */
	noteCheck(provider: string, error?: string, via: "check" | "list" = "check"): void {
		this.status.set(provider, {
			ok: !error,
			at: Date.now(),
			via,
			...(error ? { detail: clean(error) } : {}),
		});
	}

	get(provider: string): ProviderStatus | undefined {
		return this.status.get(provider);
	}
}

/** The process-wide record the model listing reads and subagent runs update. */
export const providerHealth = new ProviderHealth();

/** One line about a provider's credential for the model listing; empty when nothing is known. */
export function describeHealth(status: ProviderStatus | undefined): string {
	if (!status) return "";
	const when = new Date(status.at).toTimeString().slice(0, 5);
	const source = status.via === "list" ? "model list" : status.via === "check" ? "check" : "subagent run";
	if (status.ok && status.via === "list") return ` ✓ credential accepted (${source}, ${when}; credit not tested)`;
	if (status.ok) return ` ✓ credential worked (${source}, ${when})`;
	const refused = status.detail && CREDENTIAL_REFUSED.test(status.detail);
	return ` ✗ ${refused ? "credential refused" : "check failed"} (${source}, ${when}): ${status.detail ?? "no detail"}${refused ? " — fix with /login" : ""}`;
}

/**
 * Models a check tries per provider before it gives up: one model may be refused for itself (an account opt-in, a
 * retired id). Five, because the cheapest models of a gateway catalog are often opt-in or retired ones (OpenCode Go,
 * 2026-10-29: two contributor models and a deprecated one before the first that answered).
 */
const CHECK_CANDIDATES = 5;

/**
 * Each provider's models in the order a check tries them: this session's model for its own provider first, then the
 * cheapest priced ones; at most `limit` per provider.
 */
export function checkCandidates(
	available: readonly Model<Api>[],
	parent: ModelRef | undefined,
	limit = CHECK_CANDIDATES,
): Model<Api>[][] {
	const price = (model: Model<Api>) =>
		model.cost && model.cost.input + model.cost.output > 0 ? 3 * model.cost.input + model.cost.output : Infinity;
	const rank = (model: Model<Api>) =>
		parent?.provider === model.provider && parent.id === model.id ? -1 : price(model);
	const byProvider = new Map<string, Model<Api>[]>();
	for (const model of available) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
	// Unpriced models rank Infinity; compare rather than subtract so two of them do not yield NaN.
	const order = (a: Model<Api>, b: Model<Api>) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0);
	return [...byProvider.values()].map((models) => [...models].sort(order).slice(0, limit));
}

type CheckRegistry = Pick<ModelRegistry, "streamSimple"> &
	Partial<Pick<ModelRegistry, "getProvider" | "getProviderAuth">>;

/** A refusal a model list cannot disprove: listing models works without credit or quota. */
const BILLING_REFUSED = /insufficient[ _](?:quota|credit|balance)|billing|quota/i;

/**
 * Whether the provider's own model list accepted the credential, without an inference request. Only a success counts:
 * a failed list may be the route, not the key (Anthropic OAuth and federated tokens are not list credentials, custom
 * endpoints may lack the route), so the caller confirms failures with a request. Auth resolution is bounded by `signal`.
 */
async function listAccepted(registry: CheckRegistry, providerId: string, signal: AbortSignal): Promise<boolean> {
	const provider = registry.getProvider?.(providerId);
	if (!provider || !registry.getProviderAuth) return false;
	const aborted = new Promise<never>((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
	// The race below may settle first; a later abort must not surface as an unhandled rejection.
	aborted.catch(() => {});
	const resolved = await Promise.race([registry.getProviderAuth(providerId), aborted]);
	if (!resolved) return false;
	const listed = await checkCredentialByList(provider, resolved.auth, {
		signal,
		chatGPT: providerId === "openai" && resolved.source === "OAuth",
	});
	return listed?.ok === true;
}

/** One tiny request; the provider's error text, or undefined when it answered. */
async function tinyRequest(
	registry: CheckRegistry,
	model: Model<Api>,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		const reply = await registry
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
				// Session-routed providers refuse a request without a session: OpenCode requires `x-opencode-session`.
				{ maxTokens: 64, signal, sessionId: `credential-check-${randomUUID()}` },
			)
			.result();
		if (reply.stopReason === "error" || reply.stopReason === "aborted")
			return reply.errorMessage ?? `the request ended: ${reply.stopReason}`;
		return undefined;
	} catch (caught) {
		return errorMessage(caught);
	}
}

/**
 * Check each provider and record whether it answered: by its model list where the provider has one, otherwise with one
 * tiny request. An entry may list several models of one provider: a refusal that is not about the credential tries the
 * next, since one model can be closed to an account that others serve. Providers run in parallel with a 20 s bound each;
 * results of a check the caller cancelled are not recorded.
 */
export async function checkProviders(
	registry: CheckRegistry,
	entries: readonly (Model<Api> | readonly Model<Api>[])[],
	health: ProviderHealth,
	signal?: AbortSignal,
): Promise<void> {
	await Promise.all(
		entries.map(async (entry) => {
			const candidates: readonly Model<Api>[] = Array.isArray(entry) ? entry : [entry as Model<Api>];
			const model = candidates[0];
			if (!model) return;
			const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
			const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const accepted = await listAccepted(registry, model.provider, bounded).catch(() => false);
			if (signal?.aborted) return;
			if (accepted) {
				const known = health.get(model.provider);
				// A listed key may still lack credit: keep a run's billing refusal until a run succeeds.
				if (!(known && !known.ok && known.via === "run" && known.detail && BILLING_REFUSED.test(known.detail)))
					health.noteCheck(model.provider, undefined, "list");
				return;
			}
			let error: string | undefined;
			for (const candidate of candidates) {
				const refused = await tinyRequest(registry, candidate, bounded);
				error = refused && candidates.length > 1 ? `${candidate.id}: ${refused}` : refused;
				if (!refused || CREDENTIAL_REFUSED.test(refused) || bounded.aborted) break;
			}
			if (signal?.aborted) return;
			if (error && timeout.aborted) error = `no answer within ${CHECK_TIMEOUT_MS / 1000} s (${error})`;
			health.noteCheck(model.provider, error);
		}),
	);
	signal?.throwIfAborted();
}
