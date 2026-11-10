import { renderInstruction } from "../../core/prompt-template.ts";
import { randomUUID } from "node:crypto";
import { type Api, isUsageLimitError, type Model, type Usage } from "@octocodeai/octocode-ai";
import { checkCredentialByList } from "@octocodeai/octocode-ai/providers/discovery";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { redactSecrets, sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { currentPrice, type ModelRef } from "./model.ts";

/**
 * The account cannot pay for the request (402, "Insufficient account funds", no credit or quota left): the key is
 * fine, funds or a plan are missing, and every priced model of that provider fails the same way; its free models
 * still run (OpenCode Go: beam-free answered while a paid model said 402).
 */
export const BILLING_ERROR =
	/\b402\b|payment required|insufficient[ _](?:account[ _])?(?:quota|credit|balance|funds)|billing|out of credit/i;

/** The provider refused the key itself: 401/403, an invalid, expired or unauthorized key. */
export const CREDENTIAL_ERROR =
	/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authenticat|api[ _-]?key|credential|permission[ _]denied|expired/i;

/**
 * A provider refused the credential or the account: a credential error, no funds, or a usage limit (the shared
 * classifier the session retry uses). Narrower than a request refusal: a model-level or request-shape refusal says
 * nothing about the other models of that provider.
 */
const credentialRefused = (text: string): boolean =>
	CREDENTIAL_ERROR.test(text) || BILLING_ERROR.test(text) || isUsageLimitError(text);
/** A known price of zero for input and output; an unknown price is not free. */
const costsNothing = (cost: ModelRef["cost"]): boolean => {
	const rates = currentPrice(cost);
	return rates !== undefined && rates.input + rates.output === 0;
};
const CHECK_TIMEOUT_MS = 20_000;
/** How long a credential refusal steers routing away from its provider: a `/providers` since then is not otherwise seen. */
const REFUSAL_ROUTING_MS = 15 * 60_000;

export interface ProviderStatus {
	ok: boolean;
	at: number;
	/** `list`: the provider's model list answered (no inference); `check`: a tiny inference request; `run`: a subagent. */
	via: "run" | "check" | "list";
	detail?: string;
}

/** A client error other than a timeout (408) or a rate limit (429): the provider rejected the request itself. */
const CLIENT_ERROR = /\b4(?!08|29)\d\d\b/;

/** A run that spent no token: its first request failed, so its error is about the route, not the task. */
export const spentNothing = (usage: Usage | undefined): boolean =>
	!usage || usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0;

/**
 * A run refused before any token with a client error (an account setting, an unknown or disabled model): the same
 * request to that model fails again, whatever the task.
 */
export const refusedBeforeWork = (error: string, nothingSpent: boolean): boolean =>
	nothingSpent && CLIENT_ERROR.test(error);

const withoutThinking = (model: string) => model.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "");

/** Provider error text reaches the model listing: credentials are redacted, nothing is cut. */
const clean = (text: string) => redactSecrets(sanitizeTerminalText(text)).replace(/\s+/g, " ").trim();

/** What this process last learned about each provider's credential; the latest run or check replaces older news. */
export class ProviderHealth {
	private readonly status = new Map<string, ProviderStatus>();
	/** `provider/id` of models that refused a run before any token, and when. */
	private readonly models = new Map<string, number>();

	/**
	 * A finished subagent run on `model` ("provider/id[:level]"; undefined when it ran on this session's model): success
	 * clears a refusal, a credential refusal marks the provider, a client error before any token (`nothingSpent`) marks
	 * the model, other failures say nothing.
	 */
	noteRun(model: string | undefined, error?: string, nothingSpent = false): void {
		const provider = model?.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
		if (!model || !provider) return;
		const ref = withoutThinking(model);
		if (!error) {
			this.status.set(provider, { ok: true, at: Date.now(), via: "run" });
			this.models.delete(ref);
		} else if (credentialRefused(error))
			this.status.set(provider, { ok: false, at: Date.now(), via: "run", detail: clean(error) });
		else if (refusedBeforeWork(error, nothingSpent)) this.models.set(ref, Date.now());
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

	/**
	 * Whether, in the last `REFUSAL_ROUTING_MS`, model `id` of `provider` refused a run before any token, or (unless
	 * `proven`: the parent's own provider, whose session proves it) `provider` refused its credential (a run or check said
	 * so; a timeout or other failure does not count): routing then prefers other models (`usableModels`).
	 */
	refused(provider: string, id?: string, proven = false, cost?: ModelRef["cost"]): boolean {
		const at = id === undefined ? undefined : this.models.get(`${provider}/${id}`);
		if (at !== undefined && Date.now() - at < REFUSAL_ROUTING_MS) return true;
		if (proven) return false;
		const status = this.status.get(provider);
		if (status === undefined || status.ok || Date.now() - status.at >= REFUSAL_ROUTING_MS) return false;
		const detail = status.detail ?? "";
		// Missing funds stop only what costs money: a model priced at zero (`cost` given and free) still routes.
		if (BILLING_ERROR.test(detail) && !CREDENTIAL_ERROR.test(detail) && costsNothing(cost)) return false;
		return credentialRefused(detail);
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
	const detail = status.detail ?? "";
	const billing = BILLING_ERROR.test(detail);
	const limited = !billing && !CREDENTIAL_ERROR.test(detail) && isUsageLimitError(detail);
	const refused = billing || limited || credentialRefused(detail);
	const label = billing
		? "out of funds"
		: limited
			? "usage limit reached"
			: refused
				? "credential refused"
				: "check failed";
	const fix = billing
		? " — add funds or a plan with the provider"
		: limited
			? " — wait for the limit to reset or use another provider"
			: refused
				? " — fix with /providers"
				: "";
	return ` ✗ ${label} (${source}, ${when}): ${status.detail ?? "no detail"}${fix}`;
}

/**
 * Models a check tries per provider before it gives up: one model may be refused for itself (an account opt-in, a
 * retired id). Five, because the cheapest models of a gateway catalog are often opt-in or retired ones (OpenCode Go:
 * two contributor models and a deprecated one before the first that answered).
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
	const price = (model: Model<Api>) => {
		const rates = currentPrice(model.cost);
		return rates && rates.input + rates.output > 0 ? 3 * rates.input + rates.output : Infinity;
	};
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
const BILLING_REFUSED = new RegExp(`${BILLING_ERROR.source}|quota`, "i");

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
		credentialSource: resolved.source,
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
				{
					messages: [
						{ role: "user", content: renderInstruction("workflows/credential-check.md"), timestamp: Date.now() },
					],
				},
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
				if (!refused || credentialRefused(refused) || bounded.aborted) break;
			}
			if (signal?.aborted) return;
			if (error && timeout.aborted) error = `no answer within ${CHECK_TIMEOUT_MS / 1000} s (${error})`;
			health.noteCheck(model.provider, error);
		}),
	);
	signal?.throwIfAborted();
}
