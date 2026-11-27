/**
 * Host-side OAuth sign-in for the configuration page. The daemon runs the provider's login through the same runtime
 * login the terminal uses; the page only polls the state, shows its events and relays the user's answers. One sign-in
 * runs per provider at a time and each is stopped after a bounded lifetime. Events and errors are validated and
 * redacted before the page sees them, and the credential the login produces goes to `auth.json` inside the runtime:
 * it is never part of a state, an event or an audit row.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@octocodeai/octocode-ai";
import {
	SignInEventSchema,
	type SignInCommand,
	type SignInEvent,
	type SignInPrompt,
	type SignInState,
} from "@octocodeai/octocode-contracts/config";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Value } from "typebox/value";
import { redactSecrets, registerSecretValue } from "@octocodeai/octocode-common/sanitize";
import type { ConfigAuditEntry } from "../../../../db/src/api.ts";
import { APP_NAME } from "../../config.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../../core/model-runtime.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { ConfigWriteError } from "./config-write.ts";

/** A sign-in the page forgets after this long, so one left open does not hold a callback port or the provider's lock. */
const SIGN_IN_LIFETIME_MS = 10 * 60_000;
/** How long a finished sign-in stays readable, so a page that polls late still sees its outcome. */
const FINISHED_KEEP_MS = 5 * 60_000;
const MAX_EVENTS = 32;
/** How long after an abort a login that never settles is given before the session is closed without it. */
const ABORT_GRACE_MS = 5000;
const CANCELLED = "Login cancelled";
const TIMED_OUT = "The sign-in took too long and was stopped. Start it again.";
const DROPPED_NOTE =
	"The provider sent information that cannot be shown here. Finish the sign-in in a terminal with /providers if it stalls.";

export interface SignInOptions {
	/** Runs the provider's OAuth login with `interaction`; resolves when the credential is stored. */
	login: (providerId: string, interaction: AuthInteraction) => Promise<unknown>;
	/** Whether the provider offers an OAuth sign-in. */
	offersOAuth: (providerId: string) => Promise<boolean>;
	lifetimeMs?: number;
	/** Time a login gets to settle after cancel or timeout before it is abandoned; default 5 seconds. */
	abortGraceMs?: number;
	/** Who is acting, for the audit entry; read when a sign-in ends. */
	actor: () => string;
	/** Receives one entry when a sign-in ends. It must not throw; the sign-in does not depend on it. */
	audit?: (entry: ConfigAuditEntry) => void;
}

interface Pending {
	prompt: SignInPrompt;
	resolve: (value: string) => void;
	reject: (error: Error) => void;
}

interface Session {
	provider: string;
	status: SignInState["status"];
	events: SignInEvent[];
	pending?: Pending;
	error?: string;
	expiresAt: number;
	controller: AbortController;
	timedOut: boolean;
	/** True when the login stored a credential but a later step failed. */
	credentialSaved?: boolean;
	grace?: ReturnType<typeof setTimeout>;
	entry: ConfigAuditEntry;
	timer: ReturnType<typeof setTimeout>;
	forget?: ReturnType<typeof setTimeout>;
}

const text = (value: string, max = 1000) => redactSecrets(value).slice(0, max);
const isWebUrl = (value: string) => /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/.test(value) && value.length <= 2048;

/** The event the page may see, or undefined when it has no safe form (such as a link that is not http or https). */
function toEvent(event: AuthEvent): SignInEvent | undefined {
	let mapped: SignInEvent | undefined;
	if (event.type === "auth_url") {
		if (!isWebUrl(event.url)) return undefined;
		mapped = {
			type: "auth_url",
			url: event.url,
			...(event.instructions ? { instructions: text(event.instructions) } : {}),
		};
	} else if (event.type === "device_code") {
		if (!isWebUrl(event.verificationUri)) return undefined;
		mapped = {
			type: "device_code",
			userCode: event.userCode.slice(0, 64),
			verificationUri: event.verificationUri,
			...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
		};
	} else if (event.type === "info") {
		const links = (event.links ?? [])
			.filter((link) => isWebUrl(link.url))
			.slice(0, 8)
			.map((link) => ({ url: link.url, ...(link.label ? { label: text(link.label, 200) } : {}) }));
		mapped = { type: "info", message: text(event.message), ...(links.length > 0 ? { links } : {}) };
	} else {
		mapped = { type: "progress", message: text(event.message) };
	}
	return Value.Check(SignInEventSchema, mapped) ? mapped : undefined;
}

function toPrompt(id: string, prompt: AuthPrompt): SignInPrompt {
	const base = { id, type: prompt.type, message: text(prompt.message) };
	const placeholder =
		"placeholder" in prompt && prompt.placeholder ? { placeholder: text(prompt.placeholder, 200) } : {};
	if (prompt.type !== "select") return { ...base, ...placeholder };
	return {
		...base,
		options: prompt.options.slice(0, 50).map((option) => ({
			id: option.id.slice(0, 200),
			label: text(option.label, 200),
			...(option.description ? { description: text(option.description, 400) } : {}),
		})),
	};
}

export class SignInManager {
	private readonly sessions = new Map<string, Session>();
	private readonly options: SignInOptions;
	private closed = false;

	constructor(options: SignInOptions) {
		this.options = options;
	}

	async handle(command: SignInCommand): Promise<SignInState> {
		if (command.action === "start") return this.start(command.provider);
		if (command.action === "status") return this.state(command.provider);
		if (command.action === "cancel") {
			const session = this.sessions.get(command.provider);
			if (session?.status === "running") {
				this.abort(session);
				// The login settles on its own; wait a turn so the reply already says cancelled.
				await new Promise((resolve) => setImmediate(resolve));
			}
			return this.state(command.provider);
		}
		return this.answer(command.provider, command.promptId, command.value);
	}

	/** Stops every running sign-in; the daemon calls it on shutdown. */
	closeAll(): void {
		this.closed = true;
		for (const session of this.sessions.values()) {
			if (session.status === "running") this.finish(session, "cancelled", { errorCode: "cancelled" });
			session.controller.abort(new Error(CANCELLED));
			clearTimeout(session.timer);
			clearTimeout(session.grace);
			clearTimeout(session.forget);
		}
		this.sessions.clear();
	}

	private state(provider: string): SignInState {
		const session = this.sessions.get(provider);
		if (!session) return { provider, status: "idle", events: [] };
		return {
			provider,
			status: session.status,
			events: [...session.events],
			...(session.pending ? { prompt: session.pending.prompt } : {}),
			...(session.error ? { error: session.error } : {}),
			...(session.credentialSaved ? { credentialSaved: true } : {}),
			...(session.status === "running" ? { expiresAt: session.expiresAt } : {}),
		};
	}

	/** Records a refused sign-in request (fixed code only) and returns the error to throw. */
	private refuse(provider: string, status: number, message: string, code: string): ConfigWriteError {
		try {
			this.options.audit?.({
				at: Date.now(),
				actor: this.options.actor(),
				action: "credential.signin",
				target: provider,
				scope: "global",
				outcome: "refused",
				errorCode: code,
			});
		} catch {
			// Best effort, like every audit row.
		}
		return new ConfigWriteError(status, message, code);
	}

	private busy(provider: string): ConfigWriteError {
		return this.refuse(provider, 409, "A sign-in for this provider is already running.", "busy");
	}

	/** Stops the login: it gets a few seconds to settle, then the session is closed without it. */
	private abort(session: Session): void {
		session.controller.abort(new Error(CANCELLED));
		session.grace ??= setTimeout(
			() =>
				this.finish(session, session.timedOut ? "failed" : "cancelled", {
					error: session.timedOut ? TIMED_OUT : undefined,
					errorCode: session.timedOut ? "timeout" : "cancelled",
				}),
			this.options.abortGraceMs ?? ABORT_GRACE_MS,
		);
		session.grace.unref();
	}

	private async start(provider: string): Promise<SignInState> {
		if (this.closed) throw this.refuse(provider, 503, "The daemon is shutting down.", "closed");
		if (this.sessions.get(provider)?.status === "running") throw this.busy(provider);
		if (!(await this.options.offersOAuth(provider).catch(() => false)))
			throw this.refuse(provider, 400, "This provider has no account sign-in. Use an API key.", "unsupported");
		// Checked again after the await: a second start may have won the race, or the daemon began closing.
		if (this.closed) throw this.refuse(provider, 503, "The daemon is shutting down.", "closed");
		if (this.sessions.get(provider)?.status === "running") throw this.busy(provider);
		const previous = this.sessions.get(provider);
		if (previous) clearTimeout(previous.forget);
		const lifetime = this.options.lifetimeMs ?? SIGN_IN_LIFETIME_MS;
		const controller = new AbortController();
		const session: Session = {
			provider,
			status: "running",
			events: [],
			expiresAt: Date.now() + lifetime,
			controller,
			timedOut: false,
			entry: {
				at: Date.now(),
				actor: this.options.actor(),
				action: "credential.signin",
				target: provider,
				scope: "global",
				outcome: "failed",
			},
			timer: setTimeout(() => {
				session.timedOut = true;
				this.abort(session);
			}, lifetime),
		};
		session.timer.unref();
		this.sessions.set(provider, session);
		void this.run(session);
		return this.state(provider);
	}

	/** Ends a running session once: later results of an abandoned login are ignored. */
	private finish(
		session: Session,
		status: "succeeded" | "failed" | "cancelled",
		result: { error?: string; errorCode?: string; credentialSaved?: boolean } = {},
	): void {
		if (session.status !== "running") return;
		const { provider } = session;
		session.status = status;
		session.error = result.error;
		session.credentialSaved = result.credentialSaved;
		clearTimeout(session.timer);
		clearTimeout(session.grace);
		session.pending?.reject(new Error(CANCELLED));
		session.pending = undefined;
		session.forget = setTimeout(() => {
			if (this.sessions.get(provider) === session) this.sessions.delete(provider);
		}, FINISHED_KEEP_MS);
		session.forget.unref();
		const { entry } = session;
		entry.outcome = status === "succeeded" ? "ok" : "failed";
		if (status === "succeeded" || result.credentialSaved) entry.afterKind = "oauth";
		if (result.errorCode) entry.errorCode = result.errorCode;
		try {
			this.options.audit?.(entry);
		} catch {
			// Best effort, like every audit row.
		}
	}

	private async run(session: Session): Promise<void> {
		const { provider, controller } = session;
		const interaction: AuthInteraction = {
			signal: controller.signal,
			prompt: (prompt) => this.ask(session, prompt),
			notify: (event) => {
				if (session.status !== "running") return;
				const mapped = toEvent(event);
				// Say so rather than leave a gap: the user may be waiting for what was dropped.
				session.events.push(mapped ?? { type: "progress", message: DROPPED_NOTE });
				if (session.events.length > MAX_EVENTS) session.events.shift();
			},
		};
		try {
			await this.options.login(provider, interaction);
			this.finish(session, "succeeded");
		} catch (error) {
			if (error instanceof CredentialSynchronizationError)
				return this.finish(session, "failed", {
					error:
						"The credential was saved, but local model state could not be synchronized. Reload the page; /reload in a terminal session picks it up.",
					errorCode: "sync",
					credentialSaved: true,
				});
			if (controller.signal.aborted)
				return session.timedOut
					? this.finish(session, "failed", { error: TIMED_OUT, errorCode: "timeout" })
					: this.finish(session, "cancelled", { errorCode: "cancelled" });
			this.finish(session, "failed", {
				error: text(errorMessage(error), 500) || "The sign-in failed.",
				errorCode: "login",
			});
		}
	}

	private ask(session: Session, prompt: AuthPrompt): Promise<string> {
		if (session.status !== "running" || session.controller.signal.aborted) return Promise.reject(new Error(CANCELLED));
		// A newer question replaces an open one (a manual code raced against a callback): the old one is cancelled.
		session.pending?.reject(new Error(CANCELLED));
		return new Promise<string>((resolve, reject) => {
			const pending: Pending = { prompt: toPrompt(randomUUID().slice(0, 8), prompt), resolve, reject };
			session.pending = pending;
			const drop = () => {
				if (session.pending === pending) session.pending = undefined;
				reject(new Error(CANCELLED));
			};
			prompt.signal?.addEventListener("abort", drop, { once: true });
			session.controller.signal.addEventListener("abort", drop, { once: true });
		});
	}

	private answer(provider: string, promptId: string, value: string): SignInState {
		const session = this.sessions.get(provider);
		const pending = session?.status === "running" ? session.pending : undefined;
		if (!session || !pending || pending.prompt.id !== promptId)
			throw this.refuse(provider, 409, "That question is no longer open.", "stale");
		if (pending.prompt.type === "select" && !pending.prompt.options?.some((option) => option.id === value))
			throw this.refuse(provider, 400, "Choose one of the listed options.", "invalid");
		// A pasted code or secret must be redacted if a provider error quotes it back.
		if (pending.prompt.type === "secret" || pending.prompt.type === "manual_code") registerSecretValue(value);
		session.pending = undefined;
		pending.resolve(value);
		return this.state(provider);
	}
}

/** The login the terminal uses, run in the daemon: one lazily created runtime that reads and writes the same `auth.json`. */
export function runtimeSignIn(agentDir: string): Pick<SignInOptions, "login" | "offersOAuth"> {
	let runtime: Promise<ModelRuntime> | undefined;
	const get = () => {
		runtime ??= ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			refreshOnCreate: false,
		}).catch((error: unknown) => {
			runtime = undefined;
			throw error;
		});
		return runtime;
	};
	return {
		offersOAuth: async (providerId) => !!(await get()).getProvider(providerId)?.auth.oauth,
		login: async (providerId, interaction) =>
			(await get()).login(providerId, "oauth", interaction, {
				getDeviceId: () => SettingsManager.create(agentDir, agentDir).getOrCreateDeviceId(),
				agentName: APP_NAME,
			}),
	};
}
