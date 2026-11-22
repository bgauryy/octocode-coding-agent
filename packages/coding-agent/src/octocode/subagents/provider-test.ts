import type { ProviderTestResult } from "@octocodeai/octocode-contracts/config";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { ModelRegistry } from "../../core/model-registry.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { checkRunners, isConnected, type RunnerState } from "../external/runner-status.ts";
import {
	checkCandidates,
	checkProviders,
	describeHealth,
	type ProviderHealth,
	providerHealth,
} from "./provider-health.ts";
import { describeUnserved, servedModelReport } from "./provider-served.ts";

/** What a test needs of the host: the runtime to check, the session's model to try first, and the boundaries tests fake. */
export interface ProviderTestHost {
	runtime: ModelRuntime;
	model?: { provider: string; id: string };
	fetch?: typeof fetch;
	health?: ProviderHealth;
}

const MAX_MESSAGE = 800;
/** Providers tested at once by Test all: each one may send a request, so the burst stays small. */
const PARALLEL = 4;

const clean = (text: string) => redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);

/**
 * Tests one connected provider: one small request through the same path a run uses (a model list can accept a key that
 * inference refuses), then, free, the host's own model list against the configured ids. Spends only when called: the
 * single request is the one thing it costs, and nothing is retried or scheduled. The message is the health record's own
 * line, whose error text is already redacted; no key is shown.
 */
export async function testProvider(
	host: ProviderTestHost,
	id: string,
	name: string,
	signal?: AbortSignal,
): Promise<ProviderTestResult> {
	const health = host.health ?? providerHealth;
	const registry = new ModelRegistry(host.runtime);
	const available = registry.getAvailable().filter((candidate) => candidate.provider === id);
	const base = { id, name, kind: "provider" as const, at: Date.now() };
	if (available.length === 0)
		return {
			...base,
			status: "skipped",
			via: "none",
			message: `${name} has no available model to test with (all hidden, or no credential).`,
		};
	// Only `streamSimple`: without `getProvider`/`getProviderAuth` the check skips the model-list shortcut.
	const requestOnly = { streamSimple: registry.streamSimple.bind(registry) };
	const [, served] = await Promise.all([
		checkProviders(requestOnly, checkCandidates(available, host.model as never), health, signal),
		servedModelReport(host.runtime, id, { signal, fetch: host.fetch }),
	]);
	const status = health.get(id);
	const note = served?.kind === "listed" ? describeUnserved(served) : "";
	const listing = served?.kind === "failed" ? `model list: ${served.message}` : note;
	const detail = [status ? describeHealth(status).trim() : "the check gave no result", listing]
		.filter((part) => part !== "")
		.join(" · ");
	return {
		...base,
		status: status?.ok ? "ok" : "failed",
		via: status?.via === "list" ? "list" : "check",
		message: clean(detail),
		...(served?.kind === "listed"
			? {
					served: served.served,
					unserved: served.unserved,
					...(served.unserved.length > 0 ? { servedSample: served.servedSample } : {}),
				}
			: {}),
	};
}

/** The external agent's result from its own status command (`runner-status.ts`), not a model request. */
export function runnerResult(state: RunnerState): ProviderTestResult {
	const connected = isConnected(state);
	const method = state.auth?.method ? ` (${state.auth.method})` : "";
	const message = connected
		? `signed in${method}`
		: !state.cli
			? "its CLI is not installed"
			: state.error
				? `status unknown: ${state.error}`
				: state.auth?.signedIn === false
					? "signed out"
					: "not runnable: its adapter is missing";
	return {
		id: state.id,
		name: state.name,
		kind: "runner",
		status: connected ? "ok" : "failed",
		via: "runner",
		message: clean(message),
		at: state.checkedAt ?? Date.now(),
	};
}

/** Checks the installed external agents with their own status commands (a fresh check, not the cached one). */
export async function testRunners(options: {
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	agentDir?: string;
}): Promise<ProviderTestResult[]> {
	const states = await checkRunners({ refresh: true, ...options });
	return states.filter((state) => state.cli).map(runnerResult);
}

/** The providers a Test all covers: those with a working credential that the user has not turned off. */
export function connectedProviders(runtime: ModelRuntime): { id: string; name: string }[] {
	return runtime
		.getProviders()
		.filter((provider) => runtime.hasConfiguredAuth(provider.id) && !runtime.isProviderDisabled(provider.id))
		.map((provider) => ({ id: provider.id, name: provider.name ?? provider.id }));
}

/**
 * Test all: every connected provider, a few at a time, then the installed external agents. One provider's failure is
 * its own result; the others still run. A cancelled run rejects.
 */
export async function testAll(
	host: ProviderTestHost,
	options: {
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		agentDir?: string;
		onResult?: (result: ProviderTestResult) => void;
	} = {},
): Promise<ProviderTestResult[]> {
	const results: ProviderTestResult[] = [];
	const add = (result: ProviderTestResult) => {
		results.push(result);
		options.onResult?.(result);
	};
	const providers = connectedProviders(host.runtime);
	for (let offset = 0; offset < providers.length; offset += PARALLEL) {
		const batch = providers.slice(offset, offset + PARALLEL);
		const settled = await Promise.all(
			batch.map((provider) =>
				testProvider(host, provider.id, provider.name, options.signal).catch((error: unknown): ProviderTestResult => {
					options.signal?.throwIfAborted();
					return {
						id: provider.id,
						name: provider.name,
						kind: "provider",
						status: "failed",
						via: "none",
						message: clean(errorMessage(error)),
						at: Date.now(),
					};
				}),
			),
		);
		for (const result of settled) add(result);
	}
	for (const result of await testRunners(options)) add(result);
	return results;
}
