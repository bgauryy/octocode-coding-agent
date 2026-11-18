import { existsSync } from "node:fs";
import { resolvePath } from "@octocodeai/octocode-common/paths";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import {
	openImportedSession,
	prepareImportDestination,
	SessionImportFileNotFoundError,
	SessionNameError,
} from "./agent-session-runtime/import.ts";
import { forkTarget } from "./agent-session-runtime/messages.ts";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "./agent-session-runtime/types.ts";
import type { ReplacedSessionContext, SessionShutdownEvent, SessionStartEvent } from "./features/index.ts";
import { shutdownSession } from "./agent-session-runtime/shutdown.ts";
import { FolderAdmission } from "./folder-trust.ts";
import { assertSessionCwdExists, resolveSessionCwd } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";

export {
	SessionImportFileNotFoundError,
	SessionImportInvalidError,
	SessionNameError,
} from "./agent-session-runtime/import.ts";
export type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "./agent-session-runtime/types.ts";

/**
 * Owns the current AgentSession plus its cwd-bound services. Replacement methods tear down the current runtime, then
 * create and apply the next; a creation failure propagates to the caller, who reports it.
 */
export class AgentSessionRuntime {
	readonly folderAdmission = new FolderAdmission();
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private disposal: Promise<void> | undefined;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching feature-provided TUI components before the old feature
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.featureHost;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.featureHost;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		await shutdownSession(
			this.session,
			{ type: "session_shutdown", reason, targetSessionFile },
			this.beforeSessionInvalidate,
		);
	}

	/**
	 * The runtime owns the services it holds: the replaced ones are released here (their model runtime stops watching
	 * auth.json), unless the factory handed the same services back. A failed creation never reaches this, so the current
	 * services stay live until the next switch or `dispose`.
	 */
	private apply(result: CreateAgentSessionRuntimeResult): void {
		const replaced = this._services;
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		if (replaced !== result.services) replaced.dispose?.();
	}

	/** Replace the runtime with one for `sessionManager`, announcing why the session started. */
	private async replaceSession(
		sessionManager: SessionManager,
		cwd: string,
		reason: SessionStartEvent["reason"],
		previousSessionFile: string | undefined,
	): Promise<void> {
		this.apply(
			await this.createRuntime({
				cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason, previousSessionFile },
			}),
		);
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = await SessionManager.openAsync(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.folderAdmission.check(sessionManager.getCwd());
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		await this.replaceSession(sessionManager, sessionManager.getCwd(), "resume", previousSessionFile);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		previousName?: string;
		parentSession?: string;
		cwd?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const cwd = resolveSessionCwd(this.cwd, options?.cwd);
		const previousName = options?.previousName?.replace(/[\r\n]+/g, " ").trim();
		if (options?.previousName !== undefined && (!previousName || previousName.length > 200))
			throw new SessionNameError();
		const previousManager = this.session.sessionManager;
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}
		if (cwd !== this.cwd) await this.folderAdmission.check(cwd);
		const previousSessionFile = this.session.sessionFile;
		const sessionDir = previousManager.getSessionDir();
		// Another folder's session lives with that folder's sessions, unless a custom session directory is set.
		const home = cwd !== this.cwd && previousManager.usesDefaultSessionDir() ? undefined : sessionDir;
		const sessionManager = previousManager.isPersisted()
			? SessionManager.create(cwd, home)
			: SessionManager.inMemory(cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		await this.replaceSession(sessionManager, cwd, "new", previousSessionFile);
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			this.session.refreshContext();
		}
		await this.finishSessionReplacement(options?.withSession);
		if (previousName) {
			const origin =
				previousSessionFile && existsSync(previousSessionFile)
					? await SessionManager.openAsync(previousSessionFile, sessionDir, previousManager.getCwd())
					: previousManager;
			origin.appendSessionInfo(previousName);
		}
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		const { targetLeafId, selectedText } = forkTarget(this.session.sessionManager, entryId, position);

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			// A session with no file yet holds no conversation: forking or cloning it starts an empty session.
			const saved = existsSync(currentSessionFile);
			if (!targetLeafId || !saved) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: saved ? currentSessionFile : undefined });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				await this.replaceSession(sessionManager, this.cwd, "fork", previousSessionFile);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			// Keep the cwd this session runs in, which a resume may have moved away from the one in its file header.
			const sessionManager = await SessionManager.openAsync(
				currentSessionFile,
				sessionDir,
				this.session.sessionManager.getCwd(),
			);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			await this.replaceSession(sessionManager, sessionManager.getCwd(), "fork", previousSessionFile);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.replaceSession(sessionManager, this.cwd, "fork", previousSessionFile);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		const destination = prepareImportDestination(resolvedPath, sessionDir);
		const beforeResult = await this.emitBeforeSwitch("resume", destination.destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = await openImportedSession(resolvedPath, destination, {
			sessionDir,
			cwdOverride,
			cwd: this.cwd,
		});
		await this.folderAdmission.check(sessionManager.getCwd());
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		await this.replaceSession(sessionManager, sessionManager.getCwd(), "resume", previousSessionFile);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	/**
	 * Settle and save the active turn, shut the session down and release its services. Every exit path (quit, a signal,
	 * RPC shutdown, print mode) disposes before `process.exit`, which would drop the database mirror writes still queued:
	 * wait for them, bounded. A write still out after that is repaired at the next open.
	 */
	dispose(): Promise<void> {
		return (this.disposal ??= shutdownSession(
			this.session,
			{ type: "session_shutdown", reason: "quit" },
			this.beforeSessionInvalidate,
			this._services,
		));
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { createSessionFromServices } from "./agent-session/create-session.ts";
