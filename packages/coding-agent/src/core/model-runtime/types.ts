import type {
	Api,
	AuthCheck,
	AuthOperationOptions,
	Credential,
	CredentialStore,
	Model,
	ModelsStore,
} from "@octocodeai/octocode-ai";
import type { VirtualModelDefinition } from "../virtual-models.ts";
import type { CredentialWriteTransform } from "../runtime-credentials.ts";

export interface RegisteredVirtualModel {
	model: Model<Api>;
	route: VirtualModelDefinition["route"];
}

export interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** Allow create() to refresh model catalogs over the network. Defaults to false. */
	allowModelNetwork?: boolean;
	/** Timeout for the create-time network model refresh. */
	modelRefreshTimeoutMs?: number;
	catalogBaseUrl?: string;
	/** Optional caller cancellation for initial cache restoration and availability checks. */
	signal?: AbortSignal;
	/** Skip initial catalog and availability refresh. Static models remain available. */
	refreshOnCreate?: boolean;
}

export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	apiKey?: string;
	env?: Record<string, string>;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
}

export interface ModelRuntimeLoginOptions {
	/** Rewrites this login's credential before persistence, within the provider's serialized operation. */
	transformCredential?: CredentialWriteTransform;
}

export type CredentialSynchronizationOperation =
	| "login"
	| "logout"
	| "importCredential"
	| "setRuntimeApiKey"
	| "removeRuntimeApiKey";

/** Credentials changed successfully, but the local model/auth snapshot could not be synchronized. */
export class CredentialSynchronizationError extends Error {
	readonly providerId: string;
	readonly operation: CredentialSynchronizationOperation;
	readonly credential: Credential | undefined;

	constructor(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		options: ErrorOptions,
	) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		this.name = "CredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
		this.credential = credential;
	}
}
