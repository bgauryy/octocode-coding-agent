import type { ExtensionUIContext } from "../../core/features/index.ts";
import {
	AUDIT_NOTIFY_PREFIX,
	type AuditEntry,
	CHILD_AUDIT_CAP,
	childAuditEntry,
	isRoutine,
} from "../permission/audit.ts";
import { EXPOSURE_NOTIFY_PREFIX, parseExposure } from "../permission/provenance/exposure.ts";
import { type PermissionHeader, redactNonce } from "../permission/header.ts";
import type { ActionClass, AskReason } from "../permission/mode.ts";
import { notify } from "../shared/commands.ts";
import { headerText } from "../shared/fence.ts";
import { withDialog } from "../shared/locks.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { stringList } from "../shared/util.ts";
import type { RunningBudgets } from "./budget.ts";
import { askShortcut, refusedReplies, relayAsk, relayedQuestions } from "./relay-ask.ts";

/**
 * A subagent's dialogs, answered by its parent. The child runs in Octocode's RPC mode: its `ctx.ui.select`, `confirm` and `input`
 * arrive as `extension_ui_request` records on its stdout and wait for an `extension_ui_response` on its stdin. The parent
 * shows each one in its own UI, unchanged apart from a line naming the child (taken from the process the request arrived
 * on, never from the request), and returns the user's answer. A child is always started with `--rpc-ask`, so its permission
 * prompts and `askUser` questions arrive as one `ask` request of typed questions (`relay-ask.ts`), decoded by role; a
 * plain select, confirm or input is an extension's own dialog and carries no approval. A permission prompt's options are
 * the child's, so the grant a user picks ("Allow all shell commands for this session") applies to that child only: the
 * parent's own grants are never touched. This enforces the parent's policy; it is not a sandbox, the child is the same OS user.
 */

/** The methods that wait for an answer. */
const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor", "ask"]);

/** Dialogs shown to the user for one child in one window; the rest of the window is denied. */
const RELAY_MAX_DIALOGS = 10;
const RELAY_WINDOW_MS = 60_000;

/** What the parent says to a child it stops asking about. The child's own deny-with-a-note path carries it to the model. */
const RELAY_NO_UI_NOTE =
	"Not run: nobody can confirm this now (your coordinator has no user dialog). Do not retry; report to your coordinator what is blocked, why, and what you need.";
const RELAY_TIMEOUT_NOTE = (minutes: number) =>
	`Not run: the user did not answer within ${minutes} minutes. Do not retry; report to your coordinator what is blocked, why, and what you need.`;
const RELAY_BUSY_NOTE =
	"Not run: your previous approval is still waiting on the user. Wait for its answer before asking again.";
export const RELAY_LIMIT_NOTE = `Not run: this subagent sent more than ${RELAY_MAX_DIALOGS} approval dialogs within a minute, so the rest of that minute is denied without asking the user. Do not retry now; report to your coordinator what is blocked, why, and what you need.`;

/** The part of the parent's permission state a relay uses. */
interface RelayPermission {
	/** The parent's own mode allows every class and no reason asks. */
	allows(classes: readonly ActionClass[], reasons: readonly AskReason[]): boolean;
	/** The parent answered "Allow once" itself. */
	relayedAllow(agent: string, action: ActionClass, what: readonly string[]): void;
	/** The child's own audit entry. */
	adopt(entry: AuditEntry): void;
	/** What the parent did with the child's audit notifications instead of recording them. */
	relayNote(agent: string, note: string): void;
}

/** What the parent offers its children: its permission state always, its UI only when a person can be asked. */
export interface RelayHost {
	permission: RelayPermission;
	ui?: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify" | "ask"> | undefined;
	/** Registers the secret given to child `id` with the team, so the user's messages to it are signed; returns what ends that when the child is gone (`Team.vouch`). */
	vouch?: ((id: string, secret: string) => () => void) | undefined;
	/** Child `id` reported, on the channel only its own harness writes to, whether it read anything untrusted (`parseExposure`). */
	exposure?: ((id: string, exposed: boolean) => void) | undefined;
	/** Child `id` began or stopped waiting for the user's answer, so listings can say why it does nothing. */
	awaitingApproval?: ((id: string, waiting: boolean) => void) | undefined;
	/** Child `id` wrote output at `at`, so listings can say how long it has been quiet. */
	output?: ((id: string, at: number) => void) | undefined;
	/** Tells this session's model something about a child (`graph.tell`): a wake when it is idle, read after its turn when busy. */
	tell?: ((notice: string) => void) | undefined;
	/** The budgets of running children, so this session can show and raise them (`coordinate`). */
	budgets?: Pick<RunningBudgets, "add" | "remove"> | undefined;
}

/** The child as the parent knows it: from its own spawn, not from anything the child says. */
interface ChildWho {
	id: string;
	role?: string | undefined;
	goal?: string | undefined;
}

interface RelayOptions {
	/** The secret the parent gave this child (`PERMISSION_NONCE_FILE_ENV`; empty when none could be given): a header or audit entry without it is not the child's permission module's. */
	nonce: string;
	/** Sends one `extension_ui_response` record to the child. */
	send: (response: Record<string, unknown>) => void;
	/** Called when the child's first dialog opens (`true`) and when its last one closes (`false`). */
	onWaiting?: (waiting: boolean) => void;
	now?: () => number;
	/** How long a relayed permission ask waits for the user before it is refused (`RELAY_ASK_TIMEOUT_MS`). */
	askTimeoutMs?: number;
}

/** A permission ask the user leaves unanswered this long is refused, so a background child never waits forever. */
const RELAY_ASK_TIMEOUT_MS = 10 * 60_000;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((item, index) => item === b[index]);

export class ChildRelay {
	readonly #who: ChildWho;
	readonly #host: RelayHost | undefined;
	readonly #options: RelayOptions;
	readonly #open = new Map<string, AbortController>();
	/** Routine audit entries recorded for this child (the cap applies to these only), routine ones counted past the cap by action, and notifications refused (no nonce, or not a valid entry). */
	#adopted = 0;
	readonly #counted = new Map<string, number>();
	#refused = 0;
	/** What the parent's log already says about the last two (routine entries counted, refused). */
	#noted = { counted: 0, refused: 0 };
	#windowStart = 0;
	#shown = 0;
	#limited = false;

	constructor(who: ChildWho, host: RelayHost | undefined, options: RelayOptions) {
		this.#who = who;
		this.#host = host;
		this.#options = options;
	}

	/** Dialogs of this child open now (or queued behind another dialog). The watchdog pauses while it is above zero. */
	get open(): number {
		return this.#open.size;
	}

	/** One `extension_ui_request` record from the child. */
	handle(event: Record<string, unknown>): void {
		if (event.type === "extension_ui_dismiss") {
			if (typeof event.id === "string") this.#dismiss(event.id);
			return;
		}
		const method = String(event.method);
		if (method === "notify") {
			this.#audit(event.message);
			return;
		}
		const id = event.id;
		if (!DIALOG_METHODS.has(method) || typeof id !== "string") return;
		const title = typeof event.title === "string" ? event.title : "";
		const options = stringList(event.options) ?? [];
		const ui = this.#host?.ui;
		// A child's permission `ask` carries its header in its own field (`askShortcut` verifies it).
		const asked = method === "ask" ? relayedQuestions(event, this.#label(), this.#options.nonce) : undefined;
		const shortcut = asked && askShortcut(event, asked, this.#options.nonce);
		// What the user already allowed answers first: it needs no dialog, so no UI either.
		if (shortcut && this.#fastPath(id, shortcut.header, shortcut.options, shortcut.reply)) return;
		if (!ui || method === "editor" || this.#open.size > 0) {
			if (asked) {
				const why = !ui ? RELAY_NO_UI_NOTE : RELAY_BUSY_NOTE;
				this.#options.send({ type: "extension_ui_response", id, replies: refusedReplies(asked, why) });
			} else this.#cancel(id);
			return;
		}
		if (this.#overLimit(ui)) {
			if (asked) {
				this.#options.send({ type: "extension_ui_response", id, replies: refusedReplies(asked, RELAY_LIMIT_NOTE) });
				return;
			}
			this.#cancel(id);
			return;
		}
		// The parent's waiting hook or the answer to a child that already exited failed: forget the dialog; the child's own
		// timeout or exit ends its wait.
		void this.#show(ui, id, method, title, options, event).catch(() => this.#open.delete(id));
	}

	/**
	 * The child's audit entry, recorded in the parent's log under the child's name. Past the cap only routine entries (allowed,
	 * no ⚠ action, nobody asked) stop being recorded one by one: they are counted by action and the totals go to the log
	 * (`#report`); a destructive call, a denial, an `invariant` refusal, a mode change or a call a person answered is always
	 * recorded. A message that fails the nonce or validation is counted and reported too, never dropped unseen. Any other
	 * notification is none of the relay's business, apart from the child's report of what it read (`exposure`).
	 */
	#audit(message: unknown): void {
		if (typeof message === "string" && message.startsWith(EXPOSURE_NOTIFY_PREFIX)) {
			// A message that fails the nonce is ignored: the child then stays untrusted.
			const exposed = parseExposure(message, this.#options.nonce);
			if (exposed !== undefined) this.#host?.exposure?.(this.#who.id, exposed);
			return;
		}
		if (typeof message !== "string" || !message.startsWith(AUDIT_NOTIFY_PREFIX)) return;
		const entry = childAuditEntry(message, this.#who.id, this.#options.nonce);
		if (entry && (!isRoutine(entry) || this.#adopted < CHILD_AUDIT_CAP)) {
			if (isRoutine(entry)) this.#adopted += 1;
			this.#host?.permission.adopt(entry);
			return;
		}
		if (entry) this.#counted.set(entry.action, (this.#counted.get(entry.action) ?? 0) + 1);
		else this.#refused += 1;
		// The first of each kind is written at once; the totals when the child ends (`end`).
		if ((entry && this.#total === 1) || (!entry && this.#refused === 1)) this.#report();
	}

	get #total(): number {
		return [...this.#counted.values()].reduce((sum, count) => sum + count, 0);
	}

	/** Writes to the parent's log what it did not record of this child's audit notifications since the last time. */
	#report(): void {
		const [counted, refused] = [this.#total, this.#refused];
		const byAction = [...this.#counted].map(([action, count]) => `${action} × ${count}`).join(", ");
		const lines = [
			...(counted > this.#noted.counted
				? [
						`past the cap of ${CHILD_AUDIT_CAP}, routine entries are counted, not recorded: ${counted} (${byAction}); denied, asked and destructive ones still are`,
					]
				: []),
			...(refused > this.#noted.refused
				? [`audit notifications refused (no valid nonce, or not a valid entry): ${refused}`]
				: []),
		];
		this.#noted = { counted, refused };
		if (lines.length > 0) this.#host?.permission.relayNote(this.#who.id, lines.join("; "));
	}

	/** The child ended: close any final buffered dialog and record the remaining audit counts. */
	end(): void {
		this.cancelAll();
		this.#report();
	}

	/** The parent's own mode already allows the call: answer "Allow once" (`answer`) without a dialog, and audit it. */
	#fastPath(id: string, header: PermissionHeader, options: readonly string[], answer: object): boolean {
		const permission = this.#host?.permission;
		// The header only speeds a call up: it must list the choices of the question it came with.
		if (!permission || !sameList(header.options, options)) return false;
		if (!permission.allows([header.action, ...header.also], header.reasons)) return false;
		permission.relayedAllow(this.#who.id, header.action, header.what);
		this.#options.send({ type: "extension_ui_response", id, ...answer });
		return true;
	}

	/** Whether this dialog is past the window's limit (the first dialog opens a window; its minute ends it). */
	#overLimit(ui: NonNullable<RelayHost["ui"]>): boolean {
		const now = (this.#options.now ?? Date.now)();
		if (now - this.#windowStart >= RELAY_WINDOW_MS) {
			this.#windowStart = now;
			this.#shown = 0;
			this.#limited = false;
		}
		if (this.#shown < RELAY_MAX_DIALOGS) {
			this.#shown += 1;
			return false;
		}
		if (!this.#limited) {
			this.#limited = true;
			try {
				notify(
					ui,
					`${this.#label()} sent more than ${RELAY_MAX_DIALOGS} approval dialogs within a minute: the rest of that minute is denied.`,
					"warning",
				);
			} catch {
				// The UI is gone; the denial stands.
			}
		}
		return true;
	}

	/** `Subagent inky-kraken · implementer · fix login`: from the spawn, one line. */
	#label(): string {
		const { id, role, goal } = this.#who;
		return headerText(["Subagent", id, ...(role ? [`· ${role}`] : []), ...(goal ? [`· ${goal}`] : [])].join(" "), 200);
	}

	#cancel(id: string): void {
		this.#options.send({ type: "extension_ui_response", id, cancelled: true });
	}

	/** Shows one dialog in the parent's UI behind its other dialogs, and answers the child. */
	async #show(
		ui: NonNullable<RelayHost["ui"]>,
		id: string,
		method: string,
		title: string,
		options: readonly string[],
		event: Record<string, unknown>,
	): Promise<void> {
		const controller = new AbortController();
		this.#open.set(id, controller);
		if (this.#open.size === 1) this.#options.onWaiting?.(true);
		// A header the parent rejected is shown whole, but never with the child's secret in it.
		const shown = (text: string): string => sanitizeTerminalText(redactNonce(text, this.#options.nonce));
		const heading = `${this.#label()} asks:\n${shown(title)}`;
		// A relayed dialog is a wait even while the parent is idle (a background child asks after the parent's turn ended).
		const dialogOptions = {
			signal: controller.signal,
			blocking: true,
			...(typeof event.timeout === "number" ? { timeout: event.timeout } : {}),
		};
		let response: Record<string, unknown> = { cancelled: true };
		try {
			// `relayAsk` queues behind the parent's other dialogs itself (`ask`), so it is not wrapped again.
			const questions = method === "ask" ? relayedQuestions(event, this.#label(), this.#options.nonce) : undefined;
			response = questions
				? await this.#askBounded(ui, questions, title, controller, event)
				: await withDialog(async () => {
						if (controller.signal.aborted || method === "ask") return { cancelled: true };
						if (method === "select") {
							// Labels are drawn sanitized; the answer is the child's own label.
							const drawn = options.map(shown);
							const choice = await ui.select(heading, drawn, dialogOptions);
							const index = choice === undefined ? -1 : drawn.indexOf(choice);
							return index < 0 ? { cancelled: true } : { value: options[index] };
						}
						if (method === "confirm") {
							const message = typeof event.message === "string" ? shown(event.message) : "";
							const confirmed = await ui.confirm(heading, message, dialogOptions);
							return controller.signal.aborted ? { cancelled: true } : { confirmed };
						}
						const placeholder = typeof event.placeholder === "string" ? shown(event.placeholder) : undefined;
						const value = await ui.input(heading, placeholder, dialogOptions);
						return value === undefined ? { cancelled: true } : { value };
					}, controller.signal);
		} catch {
			// The parent's UI failed (its session was replaced): the child is told nobody answered.
		}
		// `cancelAll` may have answered already.
		if (!this.#open.delete(id)) return;
		if (this.#open.size === 0) this.#options.onWaiting?.(false);
		this.#options.send({ type: "extension_ui_response", id, ...response });
	}

	/** A relayed permission ask with a deadline: unanswered, it is refused with why and the parent's model is told. */
	async #askBounded(
		ui: NonNullable<RelayHost["ui"]>,
		questions: Parameters<typeof relayAsk>[1],
		title: string,
		controller: AbortController,
		event: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const limit =
			typeof event.timeout === "number" ? event.timeout : (this.#options.askTimeoutMs ?? RELAY_ASK_TIMEOUT_MS);
		const EXPIRED = Symbol("expired");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<typeof EXPIRED>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(EXPIRED);
			}, limit);
		});
		try {
			// A UI that ignores the abort cannot hold the child: the deadline answers it either way.
			const answer = await Promise.race([relayAsk(ui, questions, { signal: controller.signal }), deadline]);
			if (answer !== EXPIRED) return answer;
		} finally {
			clearTimeout(timer);
		}
		const minutes = Math.max(1, Math.round(limit / 60_000));
		this.#host?.tell?.(
			`${this.#who.id} waited ${minutes} min for the user to approve "${sanitizeTerminalText(redactNonce(title, this.#options.nonce)).slice(0, 120)}" and was refused. If it still needs it, ask the user (askUser), then tell ${this.#who.id} the answer.`,
		);
		return { replies: refusedReplies(questions, RELAY_TIMEOUT_NOTE(minutes)) };
	}

	/** The child closed dialog `id` itself (`extension_ui_dismiss`: its run was aborted or its timeout passed): close it in the parent's UI; the child needs no answer. */
	#dismiss(id: string): void {
		const controller = this.#open.get(id);
		if (!controller) return;
		this.#open.delete(id);
		if (this.#open.size === 0) this.#options.onWaiting?.(false);
		controller.abort();
	}

	/** Cancels every open dialog (the parent stopped the child, or it ended): closes them in the parent's UI and answers the child. */
	cancelAll(): void {
		if (this.#open.size === 0) return;
		const ids = [...this.#open.keys()];
		const controllers = [...this.#open.values()];
		this.#open.clear();
		this.#options.onWaiting?.(false);
		for (const id of ids) this.#cancel(id);
		for (const controller of controllers) controller.abort();
	}
}
