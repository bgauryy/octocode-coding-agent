import type { ExtensionAPI, ExtensionContext } from "../../../core/features/index.ts";
import { type AuditEntry, AuditLog, childAuditMessage, RELAY_VIA, WARN_ACTIONS } from "../audit.ts";
import { exposureMessage } from "../provenance/exposure.ts";
import { auditLine, auditLines } from "../effect.ts";
import {
	type ActionClass,
	type ActionCount,
	actionNoun,
	CHIPS,
	chipText,
	PERMISSION_ID,
	type PermissionMode,
} from "../mode.ts";
import type { PermissionRequest } from "../request.ts";
import type { Snapshot } from "../snapshot.ts";
import type { ActionEvent, Verdict } from "./types.ts";

/**
 * The record a `Permission` keeps: its audit log, the activity listeners, the footer chip, and a subagent's forwarding
 * of its entries to its parent. Each public method backs the `Permission` method of the same name.
 */
export class PermissionTrail {
	readonly #api: ExtensionAPI;
	readonly #isSubagent: boolean;
	/** The secret the parent gave this subagent: what marks a header or audit entry as this module's own. Empty when there is none. */
	readonly #nonce: string;
	readonly #mode: () => PermissionMode;
	readonly #chipMode: () => PermissionMode;
	readonly #agent: () => string;
	readonly #stderr: (text: string) => void;
	readonly #log: AuditLog;
	readonly #listeners = new Set<(event: ActionEvent) => void>();
	/** The no-secret note was written. */
	#unforwarded = false;
	#paintCtx: Pick<ExtensionContext, "hasUI" | "ui" | "mode"> | undefined;

	constructor(options: {
		api: ExtensionAPI;
		isSubagent: boolean;
		nonce: string;
		/** The mode that judges calls (audit entries). */
		mode: () => PermissionMode;
		/** The mode the footer chip shows: the session's own, whatever a turn's cap does to calls. */
		chipMode: () => PermissionMode;
		agent: () => string;
		stderr: (text: string) => void;
	}) {
		this.#api = options.api;
		this.#isSubagent = options.isSubagent;
		this.#nonce = options.nonce;
		this.#mode = options.mode;
		this.#chipMode = options.chipMode;
		this.#agent = options.agent;
		this.#stderr = options.stderr;
		this.#log = new AuditLog((entry) => {
			try {
				this.#api.appendEntry<AuditEntry>(PERMISSION_ID, entry);
			} catch {
				// No session to write to (it was replaced); the decision itself stands.
			}
			this.#toParent(entry);
		});
	}

	/**
	 * A subagent's session file sits in its own scratch folder, out of its parent's reach, so each entry also goes to its parent as a fire-and-forget notify that
	 * the parent records under the child's name and never shows (`childAuditEntry`). With no nonce the parent would reject
	 * it, so none is sent; the child then says so once on stderr (the parent keeps the tail), because a child without a
	 * session file has no other record. Its entries still go to its own session when it has one.
	 */
	#toParent(entry: AuditEntry): void {
		this.#send((nonce) => childAuditMessage(entry, nonce));
	}

	#send(message: (nonce: string) => string): void {
		const ctx = this.#paintCtx;
		if (!this.#isSubagent || !ctx?.hasUI) return;
		if (this.#nonce === "") {
			if (!this.#unforwarded)
				this.#stderr(
					"octocode: this subagent has no permission secret from its coordinator: its audit entries are not forwarded to the coordinator and stay in its own session only.\n",
				);
			this.#unforwarded = true;
			return;
		}
		try {
			ctx.ui.notify(message(this.#nonce), "info");
		} catch {
			// The RPC session is gone: the entry stays in the child's own log.
		}
	}

	get count(): ActionCount {
		return this.#log.count;
	}

	/** Drops the tallies at session start, counting the entries the session already recorded. */
	reset(ctx: Pick<ExtensionContext, "sessionManager">): void {
		this.#log.reset(this.#recorded(ctx));
	}

	/** Writes the rollup; a subagent that says `exposed` also tells its parent whether it read anything untrusted (`exposureMessage`). */
	flush(exposed?: boolean): void {
		this.#log.flush(Date.now(), this.#mode(), this.#agent());
		if (exposed !== undefined && this.#isSubagent) this.#send((nonce) => exposureMessage(exposed, nonce));
	}

	summary(): string | undefined {
		return this.#log.summary();
	}

	#recorded(ctx: Pick<ExtensionContext, "sessionManager">): number {
		try {
			return ctx.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === PERMISSION_ID).length;
		} catch {
			return 0;
		}
	}

	onAction(listener: (event: ActionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	refused(what: readonly string[], why: string, tool?: string): void {
		this.record({
			action: "invariant",
			what: auditLines(what),
			allowed: false,
			via: "invariant",
			note: auditLine(`${tool ? `${tool}: ` : ""}${why}`),
		});
	}

	noted(
		what: readonly string[],
		note: string,
		options: { allowed: boolean; via: "hook" | "reported" | "policy"; action?: "call" | "invariant"; tool?: string },
	): void {
		this.record({
			action: options.action ?? "call",
			what: auditLines(what),
			allowed: options.allowed,
			via: options.via,
			note: auditLine(`${options.tool ? `${options.tool}: ` : ""}${note}`),
		});
	}

	typed(command: string, cwd: string): void {
		this.record({ action: "shell", what: auditLines([command, `cwd: ${cwd}`]), allowed: true, via: "typed" });
	}

	paint(ctx: Pick<ExtensionContext, "hasUI" | "ui" | "mode">): undefined {
		this.#paintCtx = ctx;
		if (!ctx.hasUI) return undefined;
		const mode = this.#chipMode();
		const chip = CHIPS[mode];
		ctx.ui.setStatus(PERMISSION_ID, chipText(mode, this.#log.count), chip.color);
		return undefined;
	}

	decided(request: PermissionRequest, verdict: Verdict, note?: string, snapshot?: Snapshot): Verdict {
		const reasons = [...new Set(request.reasons)];
		const action = request.action ?? "call";
		this.record({
			action,
			...(reasons.length > 0 ? { reasons } : {}),
			...(request.askedAt === undefined ? {} : { askedAt: request.askedAt }),
			what: auditLines(request.what),
			...(request.purpose ? { purpose: auditLine(request.purpose) } : {}),
			...(request.reasonDerived ? { reasonDerived: true } : {}),
			allowed: verdict.allowed,
			via: verdict.via,
			// Gate-made parts (a replaced input, applied updates) or a hook's denial message: each part clipped, as `what` is.
			...(note ? { note: auditLines(note.split("\n")).join("⏎") } : {}),
			...(snapshot && "ref" in snapshot ? { snapshot: snapshot.ref } : {}),
		});
		if (verdict.allowed) {
			const event: ActionEvent = {
				action,
				what: auditLine(request.what[0] ?? ""),
				warn: WARN_ACTIONS.has(action),
				mode: this.#mode(),
			};
			for (const listener of this.#listeners) listener(event);
		}
		return verdict;
	}

	relayNote(agent: string, note: string): void {
		this.write({
			at: Date.now(),
			mode: this.#mode(),
			action: "call",
			what: [`audit entries of ${auditLine(agent)}`],
			agent: auditLine(agent),
			allowed: true,
			via: RELAY_VIA,
			note: auditLine(note),
		});
	}

	relayedAllow(agent: string, action: ActionClass, what: readonly string[]): void {
		const mode = this.#mode();
		this.write({
			at: Date.now(),
			mode,
			action,
			what: auditLines(what),
			agent: auditLine(agent),
			allowed: true,
			via: RELAY_VIA,
			note: `allowed ${actionNoun(action)} for ${auditLine(agent)} without a dialog: ${mode} mode allows it`,
		});
	}

	record(entry: Omit<AuditEntry, "at" | "mode" | "agent">): void {
		this.write({ at: Date.now(), mode: this.#mode(), agent: this.#agent(), ...entry });
	}

	write(entry: AuditEntry): void {
		const before = this.#log.count;
		this.#log.record(entry);
		if (this.#log.count !== before && this.#paintCtx) {
			try {
				this.paint(this.#paintCtx);
			} catch {
				// The session was replaced: its context is gone, and the next start paints a fresh chip.
			}
		}
	}
}
