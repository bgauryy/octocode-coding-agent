import { join } from "node:path";
import type { CredentialInfo } from "@octocodeai/octocode-ai";
import {
	CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL,
	carriesClaudeSubscriptionToken,
} from "@octocodeai/octocode-ai/api/anthropic-messages/token";
import { deriveAgentRoute } from "@octocodeai/octocode-contracts/config";
import { homeTilde } from "../../../../common/src/home-tilde.ts";
import { getAgentDir, getModelsPath } from "../../config.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { type CredentialState, credentialState } from "../provider-composer/credential-state.ts";
import { type AuthStatus, credentialSourceLabel } from "../provider-composer/types.ts";
import { providerAccessLabel } from "../provider-label.ts";

/** Exactly one of these describes a provider; every page reads it from the snapshot and derives nothing itself. */
type ProviderState = "ready" | "needs-key" | "expired" | "paused" | "no-models" | "orphaned" | "refused" | "disabled";

/** What fixes a provider that is not ready; the label is the sentence a row and a page show. */
interface ProviderNextStep {
	label: string;
	action: "sign-in" | "add-key" | "remove" | "enable" | "edit-definition" | "open";
}

export interface ProviderEntry {
	id: string;
	name: string;
	/** A provider with this id exists in the runtime (built in, or from a models.json). */
	defined: boolean;
	stored?: CredentialInfo;
	state: ProviderState;
	/** The provider is hidden by the user; `state` is then `disabled` and `statusText` still names why it is or is not usable. */
	disabled: boolean;
	models: number;
	/** The models.json that defines the provider; undefined for a built-in. */
	definitionFile?: string;
	/** Where its credential lives (a file, the keychain or a variable name), never a value. */
	credentialWhere: string;
	route: string;
	/** One sentence: a row's detail, a page's Status and the end of its title. */
	statusText: string;
	nextStep?: ProviderNextStep;
	/** Worth a row on the main page: it has a credential, is disabled, or its own models.json defines it. */
	listed: boolean;
}

export interface ProviderSnapshot {
	providers: readonly ProviderEntry[];
	/** The saved credentials the snapshot was built from. */
	saved: readonly CredentialInfo[];
	entry(id: string): ProviderEntry | undefined;
}

type Runtime = Pick<
	ModelRuntime,
	| "getProviders"
	| "getProvider"
	| "getProviderKind"
	| "getProviderAuthStatus"
	| "hasConfiguredAuth"
	| "getAvailableSnapshot"
	| "getPlanDisabledReason"
	| "getProviderDefinitionFile"
	| "listCredentials"
	| "readCredential"
	| "getAuth"
>;

export interface SnapshotInput {
	runtime: Runtime;
	disabledProviders: readonly string[];
	/** Build only these entries (a page that needs one provider). Omit: every defined or saved provider. */
	ids?: readonly string[];
}

/** Why a Claude subscription token configures nothing, or undefined. The key is resolved the way a request resolves it. */
export async function claudeSubscriptionRefusal(
	runtime: Pick<ModelRuntime, "getAuth">,
	id: string,
): Promise<string | undefined> {
	try {
		const auth = (await runtime.getAuth(id))?.auth;
		return carriesClaudeSubscriptionToken(auth?.apiKey, auth?.headers) ? CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL : undefined;
	} catch {
		return undefined;
	}
}

/** The credential's state; a credential that cannot be read counts as none saved. */
async function readCredentialState(
	runtime: Pick<ModelRuntime, "getProviderAuthStatus" | "readCredential">,
	id: string,
): Promise<CredentialState> {
	const credential = await runtime.readCredential(id, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
	return credentialState(runtime.getProviderAuthStatus(id), credential);
}

function credentialWhere(status: AuthStatus, definitionFile: string | undefined): string {
	if (status.source === "stored") {
		const authFile = homeTilde(join(getAgentDir(), "auth.json"));
		if (status.label === "keychain") return `keychain (${authFile})`;
		if (status.label === undefined || status.label === "auth.json") return authFile;
		return status.label.replace(/^saved credential in /, "");
	}
	const file = definitionFile ? homeTilde(definitionFile) : "models.json";
	if (status.source === "models_json_key") return `apiKey in ${file}`;
	if (status.source === "models_json_command") return `secret command in ${file}`;
	return credentialSourceLabel(status);
}

interface Facts {
	defined: boolean;
	configured: boolean;
	refused: boolean;
	paused: string | undefined;
	credential: CredentialState | undefined;
	stored: boolean;
	models: number;
}

const modelsFile = () => homeTilde(getModelsPath());

/** The one place a provider's state, sentence and next step are decided. */
function judge(facts: Facts, where: string, access: string): Pick<ProviderEntry, "state" | "statusText" | "nextStep"> {
	if (!facts.defined) {
		return {
			state: "orphaned",
			statusText: `credential in ${where} but no provider defines it`,
			nextStep: { label: `remove the credential, or define the provider in ${modelsFile()}`, action: "remove" },
		};
	}
	if (facts.refused) {
		return {
			state: "refused",
			statusText: "Claude subscription token refused",
			nextStep: { label: "use Claude Code under External agents, or remove the token", action: "remove" },
		};
	}
	if (facts.credential === "expired") {
		return {
			state: "expired",
			statusText: `expired · ${where}`,
			nextStep: { label: "sign in again", action: "sign-in" },
		};
	}
	if (facts.credential === "signed out") {
		return { state: "needs-key", statusText: "signed out", nextStep: { label: "sign in", action: "sign-in" } };
	}
	if (!facts.configured) {
		return facts.stored
			? {
					state: "needs-key",
					statusText: `needs key · saved credential in ${where} configures nothing`,
					nextStep: { label: "reconnect, or remove it", action: "sign-in" },
				}
			: {
					state: "needs-key",
					statusText: "needs key · no credential",
					nextStep: { label: "add a key, or set its environment variable", action: "add-key" },
				};
	}
	if (facts.paused) {
		return {
			state: "paused",
			statusText: `plan paused: ${facts.paused}`,
			nextStep: { label: "open the provider for its plan terms", action: "open" },
		};
	}
	if (facts.models === 0) {
		return {
			state: "no-models",
			statusText: `${access} · ${where} · no models available`,
			nextStep: { label: "check the model list in its definition", action: "edit-definition" },
		};
	}
	return { state: "ready", statusText: `${access} · ${where}` };
}

function describe(
	runtime: Runtime,
	id: string,
	disabledIds: ReadonlySet<string>,
	saved: readonly CredentialInfo[],
	counts: ReadonlyMap<string, number>,
	refused: boolean,
	credential: CredentialState | undefined,
): ProviderEntry {
	const stored = saved.find((entry) => entry.providerId === id);
	const provider = runtime.getProvider(id);
	const status = runtime.getProviderAuthStatus(id);
	const definitionFile = runtime.getProviderDefinitionFile(id);
	const where = credentialWhere(status, definitionFile);
	const models = counts.get(id) ?? 0;
	const judged = judge(
		{
			defined: provider !== undefined,
			configured: status.configured,
			refused,
			paused: runtime.getPlanDisabledReason(id),
			credential,
			stored: stored !== undefined,
			models,
		},
		where,
		provider ? providerAccessLabel(runtime, id) : "",
	);
	const disabled = disabledIds.has(id);
	const kind = runtime.getProviderKind(id);
	return {
		id,
		name: provider?.name ?? id,
		defined: provider !== undefined,
		stored,
		disabled,
		state: disabled ? "disabled" : judged.state,
		models,
		definitionFile,
		credentialWhere: where,
		route: deriveAgentRoute({ runner: kind === "CLI", subscription: kind === "subscription" }),
		statusText: disabled ? `off · hidden from /model · ${judged.statusText}` : judged.statusText,
		nextStep: disabled ? { label: "enable it", action: "enable" } : judged.nextStep,
		listed: disabled || stored !== undefined || runtime.hasConfiguredAuth(id) || definitionFile !== undefined,
	};
}

/**
 * Every provider the runtime defines or a credential is saved for, each with one state, one sentence and a next
 * step. The only code that reads saved credentials and derives provider status; rebuild it after any mutation.
 * A credential that cannot be listed propagates: no page may show a guess.
 */
export async function buildProviderSnapshot(input: SnapshotInput): Promise<ProviderSnapshot> {
	const { runtime, disabledProviders } = input;
	const saved = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) });
	const counts = new Map<string, number>();
	for (const model of runtime.getAvailableSnapshot()) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	const all = new Set([
		...runtime.getProviders().map((provider) => provider.id),
		...saved.map((entry) => entry.providerId),
	]);
	const wanted = input.ids ? [...all].filter((id) => input.ids?.includes(id)) : [...all];
	const disabledIds = new Set(disabledProviders);
	const entries = await Promise.all(
		wanted.map(async (id) => {
			const isSaved = saved.some((entry) => entry.providerId === id);
			const configured = runtime.getProviderAuthStatus(id).configured;
			const refused = isSaved && !configured && (await claudeSubscriptionRefusal(runtime, id)) !== undefined;
			const oauth = saved.some((entry) => entry.providerId === id && entry.type === "oauth");
			const credential = oauth ? await readCredentialState(runtime, id) : undefined;
			return describe(runtime, id, disabledIds, saved, counts, refused, credential);
		}),
	);
	entries.sort((a, b) => a.name.localeCompare(b.name));
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return { providers: entries, saved, entry: (id) => byId.get(id) };
}
