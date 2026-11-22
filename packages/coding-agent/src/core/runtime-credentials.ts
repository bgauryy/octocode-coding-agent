import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@octocodeai/octocode-ai";
import type { HeldCredential } from "./auth-storage.ts";
import { registerCredentialSecrets, registerResolvedSecret } from "./secret-redaction.ts";

/**
 * Rewrites a credential just before it is saved, e.g. to move a key into a keychain. `previous` is what storage held.
 * A transform that writes outside storage sets `rollback`, which undoes that write when the credential is not saved.
 */
export interface CredentialWriteTransform {
	(credential: Credential, previous?: Credential): Promise<Credential>;
	/**
	 * Called once after a failed save, with the credential storage held before, while the storage lock is held. Must not
	 * throw secrets. When it throws, the write fails with `CredentialWriteFailure` outcome `unknown`.
	 */
	rollback?: (previous: Credential | undefined) => Promise<void>;
}

/** A store that runs a compensation step before it releases its lock when a write fails (`AuthStorage`). */
interface GuardedCredentialStore extends CredentialStore {
	modifyGuarded(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options: AuthOperationOptions | undefined,
		onFailure: (held: HeldCredential) => Promise<void>,
	): Promise<Credential | undefined>;
}

/** A store that reports changes made to its file by another process (`AuthStorage`). */
interface WatchableCredentialStore extends CredentialStore {
	watch(onChange: () => void): () => void;
}

const isWatchable = (store: CredentialStore): store is WatchableCredentialStore => "watch" in store;

const isGuarded = (store: CredentialStore): store is GuardedCredentialStore => "modifyGuarded" in store;

/**
 * What a failed transformed write left behind. `saved`: the file holds the new credential, so the outside write must
 * stay. `unknown`: the file could not be read, or the outside write could not be undone, so either may have changed.
 */
export type CredentialWriteOutcome = "saved" | "unknown";

/** A transformed write failed and its state is not "nothing changed". `message` is the original failure's. */
export class CredentialWriteFailure extends Error {
	readonly outcome: CredentialWriteOutcome;
	constructor(outcome: CredentialWriteOutcome, cause: unknown) {
		super(cause instanceof Error ? cause.message : "The credential could not be saved.", { cause });
		this.name = "CredentialWriteFailure";
		this.outcome = outcome;
	}
}

const sameCredential = (a: Credential | undefined, b: Credential | undefined) =>
	JSON.stringify(a) === JSON.stringify(b);

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	/** Shared credentials available to a fresh session, without this process's API-key overrides. */
	readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();
	private readonly writeTransforms = new Map<string, CredentialWriteTransform>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	/** Calls `onChange` when another process changes the stored credentials; a store that cannot tell never calls it. */
	watch(onChange: () => void): () => void {
		return isWatchable(this.store) ? this.store.watch(onChange) : () => {};
	}

	/** The fallback auth file (Pi's or a legacy one) that supplies the provider's saved credential, if it is one. */
	credentialOrigin(providerId: string): string | undefined {
		const store = this.store as { credentialOrigin?: (providerId: string) => string | undefined };
		return store.credentialOrigin?.(providerId);
	}

	/** Where Octocode's own `auth.json` keeps the provider's secret, when its store can tell. */
	storedIn(providerId: string): "keychain" | "auth.json" | undefined {
		const store = this.store as { storedIn?: (providerId: string) => "keychain" | "auth.json" | undefined };
		return store.storedIn?.(providerId);
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		registerResolvedSecret(apiKey);
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const override = this.overrides.get(providerId);
		if (override) return { type: "api_key", key: override };
		const credential = await this.store.read(providerId, options);
		registerCredentialSecrets(credential);
		return credential;
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		options?.signal?.throwIfAborted();
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	/** Runs `run` while credentials saved for `providerId` pass through `transform`, e.g. to move a key into a keychain. */
	async withWriteTransform<T>(
		providerId: string,
		transform: CredentialWriteTransform,
		run: () => Promise<T>,
	): Promise<T> {
		this.writeTransforms.set(providerId, transform);
		try {
			return await run();
		} finally {
			if (this.writeTransforms.get(providerId) === transform) this.writeTransforms.delete(providerId);
		}
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		// A login or token refresh produces the credential here; remember it before a transform can swap it for a reference.
		const remembering = async (current: Credential | undefined) => {
			const next = await fn(current);
			registerCredentialSecrets(next);
			return next;
		};
		const transform = this.writeTransforms.get(providerId);
		if (!transform) return this.store.modify(providerId, remembering, options);
		return this.modifyWithTransform(providerId, remembering, transform, options);
	}

	/** Once an external secret write starts, finish saving its reference even if the caller cancels. */
	private async modifyWithTransform(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		transform: CredentialWriteTransform,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const controller = new AbortController();
		const onAbort = () => controller.abort(options?.signal?.reason);
		const detach = () => options?.signal?.removeEventListener("abort", onAbort);
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		if (options?.signal?.aborted) onAbort();
		let before: Credential | undefined;
		let written: Credential | undefined;
		// Set before the transform runs: it may write outside storage and then fail or time out.
		let transformStarted = false;
		let outcome = undefined as CredentialWriteOutcome | undefined;
		let compensated = false;
		const modifyFn = async (current: Credential | undefined) => {
			const next = await fn(current);
			controller.signal.throwIfAborted();
			if (next === undefined) return undefined;
			detach();
			before = current;
			transformStarted = true;
			written = await transform(next, current);
			return written;
		};
		/** Runs with the lock held: decides from the file as it is now whether the outside write stays. */
		const compensate = async (held: HeldCredential) => {
			compensated = true;
			if (!transformStarted) return;
			if (held === "unreadable") {
				outcome = "unknown";
				return;
			}
			// A reference equal to the earlier one reads the same whether or not the file was replaced; the save was
			// reported as failed, so the outside write is undone.
			if (written && sameCredential(held.credential, written) && !sameCredential(before, written)) {
				outcome = "saved";
				return;
			}
			try {
				await transform.rollback?.(before);
			} catch {
				outcome = "unknown";
			}
		};
		const modifyOptions = { ...options, signal: controller.signal };
		try {
			if (isGuarded(this.store)) return await this.store.modifyGuarded(providerId, modifyFn, modifyOptions, compensate);
			return await this.store.modify(providerId, modifyFn, modifyOptions);
		} catch (error) {
			// A store without the lock-held hook (or a backend that ignores it): undo after the lock is gone.
			if (transformStarted && !compensated) await compensate(await this.heldBy(providerId));
			if (outcome) throw new CredentialWriteFailure(outcome, error);
			throw error;
		} finally {
			detach();
		}
	}

	/** Reads what storage holds for `providerId`, outside the lock the failed write held. */
	private async heldBy(providerId: string): Promise<HeldCredential> {
		try {
			return { credential: await this.store.modify(providerId, async () => undefined) };
		} catch {
			return "unreadable";
		}
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.store.delete(providerId, options);
		this.overrides.delete(providerId);
	}
}
