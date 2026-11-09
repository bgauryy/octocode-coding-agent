import { renderInstruction } from "../../core/prompt-template.ts";
import type { FileInputReplacement } from "../tool-input/claude-file.ts";
import type { ToolInvocation } from "../../core/features/types.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { notify } from "../shared/commands.ts";
import { envFlag, PERMISSION_RELAY_ENV, takeNonce } from "../../../../common/src/env.ts";
import { interactive } from "../shared/interactive.ts";
import type { SourceDecision } from "./source-policy/rules.ts";
import type { AuditEntry } from "./audit.ts";
import {
	ACTION_CLASSES,
	type ActionClass,
	type ActionCount,
	type AskReason,
	carryMode,
	decide,
	kindOf,
	PERMISSION_CYCLE,
	PERMISSION_ID,
	type PermissionMode,
	parseGrants,
	reasonAsks,
	runsUnasked,
	sessionStartMode,
} from "./mode.ts";
import type { PermissionRequest } from "./request.ts";
import { type CheckHost, checkPermission, selectedFileQueries } from "./ask/check.ts";
import { TurnCap } from "./ask/cap.ts";
import { modeSummary, revertedNotice, selectAnswer, unaskedRunLine } from "./ask/text.ts";
import { PermissionTrail } from "./ask/trail.ts";
import type {
	ActionEvent,
	Asker,
	Dialog,
	PermissionResolver,
	PrepareReplacement,
	PrepareUpdates,
	Verdict,
} from "./ask/types.ts";

/**
 * The permission state of one session and the only way anything asks the user about an agent action. A check runs
 * the mode table, then the session grants, then the dialog; without a UI, or in a subagent, every ask is denied.
 * Every call that reaches a check, and every refusal an invariant makes, is audited.
 */
export class Permission {
	readonly #api: ExtensionAPI;
	readonly #env: NodeJS.ProcessEnv;
	readonly #isSubagent: boolean;
	/** A subagent whose parent can ask a person: its dialogs are relayed to the parent (RPC) instead of denied. */
	readonly #relay: boolean;
	/** The secret the parent gave this subagent: what marks a header or audit entry as this module's own. Empty when there is none. */
	readonly #nonce: string;
	readonly #agent: () => string;
	readonly #stderr: (text: string) => void;
	readonly #snapshotMs: number | undefined;
	/** The classes the parent's spawn grant allowed this subagent. */
	readonly #spawnGrants: ReadonlySet<ActionClass>;
	/** Session grants by `action\0key`, with their label. */
	readonly #grants = new Map<string, string>();
	/** The user's "Deny <label> for this session" answers, by the same keys as the grants. */
	readonly #denials = new Map<string, string>();
	/** Kinds of action the user allowed for the whole session ("all shell commands"). */
	readonly #kinds = new Set<ActionClass>();
	/** Profiles (by name and content hash) whose declared permissions the user saw and allowed this session. */
	readonly #seenProfiles = new Set<string>();
	readonly #trail: PermissionTrail;
	#mode: PermissionMode = "manual";
	readonly turnCap = new TurnCap();
	#started = false;
	#warned = false;
	#answeredSourceAsks = new WeakSet<ToolInvocation>();
	#unprojectedSourcePolicy?: (toolName: string) => SourceDecision;
	unprojectedSourceDecision(toolName: string): SourceDecision | undefined {
		return this.#unprojectedSourcePolicy?.(toolName);
	}
	#sourcePolicy?: (invocation: ToolInvocation, cwd: string) => SourceDecision;
	setSourcePolicy(
		evaluate: (invocation: ToolInvocation, cwd: string) => SourceDecision,
		unprojected?: (toolName: string) => SourceDecision,
	): void {
		this.#sourcePolicy = evaluate;
		this.#unprojectedSourcePolicy = unprojected;
		this.#answeredSourceAsks = new WeakSet();
		this.#invalidate();
	}
	sourceDecision(invocation: ToolInvocation, cwd: string): SourceDecision | undefined {
		return this.#sourcePolicy?.(invocation, cwd);
	}
	replacementSourceDecision(invocation: ToolInvocation, cwd: string, indices?: number[]): SourceDecision | undefined {
		const source = this.sourceDecision(invocation, cwd);
		const narrowed = source?.decision === "ask" ? selectedFileQueries(invocation, indices) : undefined;
		return narrowed ? this.sourceDecision(narrowed, cwd) : source;
	}
	get hasSourcePolicy(): boolean {
		return this.#sourcePolicy !== undefined;
	}
	#resolver?: PermissionResolver;
	setResolver(resolver: PermissionResolver): void {
		this.#resolver = resolver;
	}
	#prepareUpdates?: PrepareUpdates;
	setUpdateHandler(prepare: PrepareUpdates): void {
		this.#prepareUpdates = prepare;
	}
	#policy = new AbortController();
	readonly #revoked = new Set<() => void>();
	/** What the check pipeline reads and writes of this session. */
	readonly #host: CheckHost;

	constructor(options: {
		api: ExtensionAPI;
		env?: NodeJS.ProcessEnv;
		isSubagent: boolean;
		agent?: () => string | undefined;
		stderr?: (text: string) => void;
		snapshotMs?: number;
	}) {
		this.#api = options.api;
		this.#env = options.env ?? process.env;
		this.#isSubagent = options.isSubagent;
		this.#relay = options.isSubagent && envFlag(this.#env, PERMISSION_RELAY_ENV);
		// Read once from the parent's file (which is unlinked) and kept by the process (`ownNonce`), so the team can check a message the parent signed.
		const nonce = takeNonce(this.#env);
		this.#nonce = options.isSubagent ? (nonce ?? "") : "";
		this.#agent = () => options.agent?.() ?? (options.isSubagent ? "subagent" : "main");
		this.#stderr =
			options.stderr ??
			((text) => {
				process.stderr.write(text);
				return undefined;
			});
		this.#snapshotMs = options.snapshotMs;
		this.#spawnGrants = options.isSubagent ? parseGrants(this.#env) : new Set();
		this.#trail = new PermissionTrail({
			api: this.#api,
			isSubagent: this.#isSubagent,
			nonce: this.#nonce,
			mode: () => this.mode,
			chipMode: () => this.#mode,
			agent: this.#agent,
			stderr: this.#stderr,
		});
		this.#host = {
			mode: () => this.mode,
			policy: () => this.#policy,
			answeredSourceAsks: () => this.#answeredSourceAsks,
			resolver: () => this.#resolver,
			prepareUpdates: () => this.#prepareUpdates,
			spawnGrants: this.#spawnGrants,
			kinds: this.#kinds,
			grants: this.#grants,
			denials: this.#denials,
			snapshotMs: this.#snapshotMs,
			relay: this.#relay,
			isSubagent: this.#isSubagent,
			select: (ctx, request) => this.#select(ctx, request),
			replacementSourceDecision: (invocation, cwd, indices) => this.replacementSourceDecision(invocation, cwd, indices),
			decided: (request, verdict, note, snapshot) => this.#trail.decided(request, verdict, note, snapshot),
		};
	}

	get mode(): PermissionMode {
		return this.turnCap.apply(this.#mode);
	}

	/** What full mode ran this session (the footer counter). */
	get count(): ActionCount {
		return this.#trail.count;
	}

	/**
	 * Session start: settles the mode (`sessionStartMode`; a `reason` says a replaced runtime came before this one), drops
	 * the grants and the tallies, and, in a run with no UI, says on stderr that full mode runs everything and where the record is.
	 */
	start(ctx: ExtensionContext, reason?: Parameters<typeof sessionStartMode>[2]): void {
		const { mode, reverted, warning } = sessionStartMode(this.#env, this.#started ? this.#mode : undefined, reason);
		this.#started = true;
		this.#mode = mode;
		carryMode(this.#env, mode);
		if (reverted) {
			if (interactive(ctx, this.#isSubagent)) notify(ctx.ui, revertedNotice(mode, reverted), "warning");
			else this.#stderr(`octocode: ${revertedNotice(mode, reverted)}\n`);
		}
		this.clearGrants();
		this.#trail.reset(ctx);
		if (warning && !this.#warned && interactive(ctx, this.#isSubagent)) notify(ctx.ui, warning, "warning");
		if (warning) this.#warned = true;
		// An RPC or ACP worker has dialogs but `full` raises none, so its driver needs the same line a headless run gets.
		const unasked = (!ctx.hasUI || ctx.mode === "rpc") && !this.#isSubagent && unaskedRunLine(mode);
		if (unasked) this.#stderr(unasked(ctx.sessionManager.getSessionFile()));
		this.paint(ctx);
	}

	/** Session end: writes the rollup of unlogged entries, tells a subagent's parent whether it was `exposed`, and, in a run with no UI, prints what full mode did to stderr. */
	shutdown(ctx: Pick<ExtensionContext, "hasUI">, exposed?: boolean): void {
		this.#trail.flush(exposed);
		const summary = !ctx.hasUI && !this.#isSubagent && runsUnasked(this.#mode) ? this.#trail.summary() : undefined;
		if (summary) this.#stderr(`${summary}\n`);
	}

	/** Writes the rollup of entries left out of the audit so far (the log command calls it so the rollup is shown). */
	flushAudit(): void {
		this.#trail.flush();
	}

	#confirmStop?: (ctx: ExtensionContext, mode: PermissionMode) => Promise<boolean>;
	/** Asked before a user's mode change that clears the grants, which stops every delegated run (`stop-confirm.ts`). */
	setConfirmStop(confirm: (ctx: ExtensionContext, mode: PermissionMode) => Promise<boolean>): void {
		this.#confirmStop = confirm;
	}

	/** Whether `mode` asks for some action the current mode allows: the change clears the grants. */
	#narrows(mode: PermissionMode): boolean {
		return ACTION_CLASSES.some((action) => decide(this.#mode, action) === "allow" && decide(mode, action) === "ask");
	}

	/** The user's mode change (command or editor shortcut): a narrowing one asks `confirmStop` first; false when declined (the mode stays). */
	async chooseMode(mode: PermissionMode, ctx: ExtensionContext): Promise<boolean> {
		if (mode !== this.#mode && this.#narrows(mode) && this.#confirmStop && !(await this.#confirmStop(ctx, mode))) {
			this.paint(ctx);
			return false;
		}
		this.setMode(mode, ctx);
		return true;
	}

	/** Changes the mode at once, without `confirmStop` (`chooseMode` is the user's path). */
	setMode(mode: PermissionMode, ctx: ExtensionContext): void {
		if (mode === this.#mode) {
			this.paint(ctx);
			return;
		}
		const from = this.#mode;
		const narrows = this.#narrows(mode);
		this.#mode = mode;
		carryMode(this.#env, mode);
		if (narrows) this.clearGrants();
		else this.#invalidate();
		this.paint(ctx);
		this.#trail.record({ action: "mode", what: [`${from} → ${mode}`], allowed: true, via: "user" });
		if (interactive(ctx, this.#isSubagent))
			notify(ctx.ui, `Permission mode: ${mode}. ${modeSummary(mode)}`, runsUnasked(mode) ? "warning" : "info");
		// Hidden and turn-neutral: during a run Octocode appends it after the current turn's results, so the model reads it next.
		const summary = modeSummary(mode);
		void this.#api.sendMessage(
			{
				customType: PERMISSION_ID,
				content: renderInstruction("notices/permission-mode.md", { id: PERMISSION_ID, mode, summary }),
				display: false,
				details: { mode },
			},
			{ triggerTurn: false },
		);
	}

	/** The editor shortcut: the next mode in `PERMISSION_CYCLE`, wrapping to the first, through `chooseMode`. */
	cycle(ctx: ExtensionContext): Promise<boolean> {
		return this.chooseMode(PERMISSION_CYCLE[(PERMISSION_CYCLE.indexOf(this.#mode) + 1) % PERMISSION_CYCLE.length], ctx);
	}

	/** Session grants, as `action: label`. */
	grants(): string[] {
		return [
			...[...this.#kinds].map((action) => `${action}: all ${kindOf(action)}`),
			...[...this.#grants, ...this.#denials].map(([key, label]) => `${key.split("\0")[0]}: ${label}`),
		];
	}

	/** Whether the user allowed all of `action` for this session. */
	kindGranted(action: ActionClass): boolean {
		return this.#kinds.has(action);
	}

	/** The kinds a subagent of this session runs without asking (it cannot ask anyone): those allowed for the session. */
	childGrants(): ActionClass[] {
		return [...this.#kinds];
	}

	/** Whether the user already allowed the profile `key` (name and content hash) this session. */
	profileSeen(key: string): boolean {
		return this.#seenProfiles.has(key);
	}

	markProfileSeen(key: string): void {
		this.#seenProfiles.add(key);
	}

	clearGrants(): void {
		this.#grants.clear();
		this.#denials.clear();
		this.#kinds.clear();
		this.#seenProfiles.clear();
		this.#invalidate();
		for (const listener of this.#revoked) listener();
	}

	/** Removes the external-message grants (and denials) alone and says how many: nothing delegated rests on them, so nothing stops. */
	clearMessageGrants(): number {
		const action = "message.external";
		let count = this.#kinds.delete(action) ? 1 : 0;
		for (const answers of [this.#grants, this.#denials])
			for (const key of answers.keys()) if (key.startsWith(`${action}\0`) && answers.delete(key)) count++;
		if (count > 0) this.#invalidate();
		return count;
	}

	/** Delegated runs must stop when their session grants or permission scope are revoked. */
	onRevoke(listener: () => void): () => void {
		this.#revoked.add(listener);
		return () => this.#revoked.delete(listener);
	}

	/** Calls `listener` for every call a check let through (the activity line). */
	onAction(listener: (event: ActionEvent) => void): () => void {
		return this.#trail.onAction(listener);
	}

	#invalidate(): void {
		this.#policy.abort();
		this.#policy = new AbortController();
	}

	/** The only way anything asks. `dialog` (the file review) replaces the default select; every rule stays here. */
	async check(ctx: Asker, call: PermissionRequest, dialog?: Dialog): Promise<Verdict> {
		return checkPermission(this.#host, ctx, call, dialog);
	}

	/** Native outer gates can stage a replacement before any tool effects; inner checks have no commit capability. */
	async checkWithReplacement(ctx: Asker, call: PermissionRequest, prepare: PrepareReplacement): Promise<Verdict> {
		return checkPermission(this.#host, ctx, call, undefined, { prepare });
	}

	async checkWithFileReplacement(
		ctx: Asker,
		call: PermissionRequest,
		prepareFile: (inputs: FileInputReplacement[]) => ReturnType<PrepareReplacement>,
		dialog?: Dialog,
	): Promise<Verdict> {
		return checkPermission(this.#host, ctx, call, dialog, { prepareFile });
	}

	/**
	 * Records a refusal an invariant made (a reservation, Octocode's home, a private redirect, a failed attach check, a
	 * hook's deny, an untrusted project's shared memory): no mode skips it, and the audit says what was refused and why.
	 */
	refused(what: readonly string[], why: string, tool?: string): void {
		this.#trail.refused(what, why, tool);
	}

	/**
	 * Records something that happened outside a check, with the verdict it had: a hook that timed out or crashed (`via: 'hook'`,
	 * allowed when the call went on), or a fact reported after the event that no check could stop (`via: 'reported'`).
	 * `action` is `call` unless the entry is an `invariant`; `tool` names who it came from.
	 */
	noted(
		what: readonly string[],
		note: string,
		options: { allowed: boolean; via: "hook" | "reported" | "policy"; action?: "call" | "invariant"; tool?: string },
	): void {
		this.#trail.noted(what, note, options);
	}

	/** A command the user typed: consent by typing, so it runs, and the audit still says so. */
	typed(command: string, cwd: string): void {
		this.#trail.typed(command, cwd);
	}

	/** Paints the footer chip (Octocode keeps the plain text over RPC). */
	paint(ctx: Pick<ExtensionContext, "hasUI" | "ui" | "mode">): undefined {
		return this.#trail.paint(ctx);
	}

	/** The default dialog: allow once, allow exactly this for the session (when it can be named), deny, deny with a note. */
	readonly #select: Dialog = async (ctx, request) => selectAnswer(ctx, request, this.mode, this.#relay, this.#nonce);

	/** Whether this session's own mode allows every class of a subagent's prompt and no reason on it asks: the parent may answer it itself. */
	allows(classes: readonly ActionClass[], reasons: readonly AskReason[]): boolean {
		return (
			classes.every((each) => decide(this.mode, each) === "allow") &&
			!reasons.some((reason) => reasonAsks(this.mode, reason))
		);
	}

	/** Records an audit entry a subagent sent (already validated by `childAuditEntry`): under its own name, in this session's log and tallies. */
	adopt(entry: AuditEntry): void {
		this.#trail.write(entry);
	}

	/** Records, under `agent`'s name, what the parent did with that subagent's audit notifications instead of recording them (never counted as a call). */
	relayNote(agent: string, note: string): void {
		this.#trail.relayNote(agent, note);
	}

	/** Records that this session's mode answered `agent`'s "Allow once" for `action` without a dialog (the child's own entry counts the call). */
	relayedAllow(agent: string, action: ActionClass, what: readonly string[]): void {
		this.#trail.relayedAllow(agent, action, what);
	}
}
