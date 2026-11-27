import type { FeatureSetup, FeatureContext } from "../../../core/features/index.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { headerText } from "../../shared/fence.ts";
import { EXTERNAL_MESSAGE_TYPE, EXTERNAL_SENDER, type MessageEnvelope, USER_SENDER } from "../../shared/messages.ts";
import { redactSecrets, visibleControls } from "@octocodeai/octocode-common/sanitize";
import { capChars } from "../../shared/util.ts";
import type { EventLog } from "../events.ts";
import {
	ERR,
	MESSAGE_KEY_MAX,
	numberParam,
	PREPARING,
	RpcError,
	SEND_ACK_MS,
	stringParam,
	WAIT_MS,
	WAITING_FOR_USER,
} from "../protocol.ts";
import { preparationExpired, type SendReceipt, type SendReceipts } from "../receipts.ts";
import { sessionApiTurnCeiling } from "../enabled.ts";
import { admission, callerFrom, callerOwner, type ExternalFacts, externalContent, externalFacts } from "./caller.ts";
import type { AgentDirectory, ApiOperations, TurnCeiling } from "./contracts.ts";

/** Senders a client may not claim: the user, the team's own API sender, and (checked per call) any live agent. */
const RESERVED_SENDERS = new Set([USER_SENDER, `the ${USER_SENDER}`, EXTERNAL_SENDER]);

/** What `message.send` needs of the API it runs in; `OctocodeApi` passes its own state and checks. */
interface SendHost {
	readonly api: FeatureSetup;
	readonly agents: AgentDirectory;
	readonly operations: ApiOperations;
	readonly receipts: SendReceipts;
	readonly log: EventLog;
	/** The bound session; throws when there is none. */
	session(): FeatureContext;
	/** Refuses a call whose `expectedSessionId` no longer names the session. */
	guardSession(params: Record<string, unknown>, ctx: FeatureContext): void;
	/** The next message id (`x1`, `x2`, …). */
	nextId(): string;
	/** Records an API-started turn in the session. */
	audit(data: Record<string, unknown>): void;
	/** Which listener took this call. */
	transport?: "socket" | "http";
	/** The caller's facts, verified with the instance it names when it names one (`bridge/verify.ts`), waiting at most `timeoutMs`; without it every caller is unverified. */
	verify?(facts: ExternalFacts, timeoutMs: number): Promise<ExternalFacts>;
}

/** The sender name a client gave, on one line; a name that would pass for the user, the team or a live agent is refused. */
function sender(host: SendHost, params: Record<string, unknown>): string {
	const given = stringParam(params, "from", { max: 64, optional: true });
	const from = headerText((given ?? "external client").replaceAll('"', " "), 64) || "external client";
	// Compared in one folded form (compatibility forms such as fullwidth letters, and letter case), so "ＵＳＥＲ" is "user".
	const fold = (name: string) => name.normalize("NFKC").toLowerCase();
	const folded = fold(from);
	const taken = host.agents.list().some((agent) => {
		const id = typeof agent === "object" && agent !== null ? (agent as { id?: unknown }).id : undefined;
		return typeof id === "string" && fold(id) === folded;
	});
	if (RESERVED_SENDERS.has(folded) || taken)
		throw new RpcError(
			ERR.invalidParams,
			`The sender name ${JSON.stringify(from)} is reserved for the user or a team agent; name your client instead (for example "ci bot"). Nothing was sent.`,
		);
	return from;
}

export async function sendMessage(host: SendHost, params: Record<string, unknown>): Promise<unknown> {
	const ctx = host.session();
	const originalSessionId = ctx.sessionManager.getSessionId();
	host.guardSession(params, ctx);
	const from = sender(host, params);
	const caller = callerFrom(params);
	const raw = stringParam(params, "text")!;
	const whole = visibleControls(raw);
	const mode = params.mode ?? "auto";
	if (mode !== "auto" && mode !== "steer" && mode !== "followUp")
		throw new RpcError(ERR.invalidParams, "mode must be auto, steer or followUp");
	if (params.requireIdle !== undefined && typeof params.requireIdle !== "boolean")
		throw new RpcError(ERR.invalidParams, "requireIdle must be a boolean");
	const requireIdle = params.requireIdle === true;
	const wait = params.wait === true;
	if (params.replyRequired !== undefined && typeof params.replyRequired !== "boolean")
		throw new RpcError(ERR.invalidParams, "replyRequired must be a boolean");
	const replyRequired = params.replyRequired === true;
	const timeout = numberParam(params, "timeoutMs", WAIT_MS) ?? WAIT_MS.default;
	const key = stringParam(params, "key", { optional: true, max: MESSAGE_KEY_MAX });
	const fingerprint = sha256(
		JSON.stringify({ raw, from, mode, requireIdle, ...(replyRequired ? { replyRequired } : {}) }),
	);
	const prior = key ? host.receipts.get(key) : undefined;
	if (prior) {
		if (prior.fingerprint !== fingerprint)
			throw new RpcError(ERR.invalidParams, "The message key was already used for different input; nothing was sent", {
				execution: "not-sent",
			});
		if (wait) return { ...prior.accepted, ...(await host.receipts.wait(prior, timeout)) };
		let ackTimer: NodeJS.Timeout | undefined;
		const stillPreparing = await Promise.race([
			prior.ready.then(() => false),
			new Promise<boolean>((resolve) => {
				ackTimer = setTimeout(() => resolve(true), Math.min(SEND_ACK_MS, timeout));
			}),
		]).finally(() => clearTimeout(ackTimer));
		if (stillPreparing) return { ...prior.accepted, queued: PREPARING, key };
		// `fail` records the failure whenever it marks a receipt uncertain.
		if (prior.phase === "uncertain") throw prior.failure!;
		return prior.accepted;
	}
	const earlier = key ? host.receipts.persisted(key) : undefined;
	if (earlier) {
		// An earlier process took this key. Its message is in the session (`accepted`), failed after dispatch
		// (`uncertain`), or never left preparation (`preparing`): nothing was sent, so this call sends it.
		if (earlier.fingerprint !== fingerprint)
			throw new RpcError(ERR.invalidParams, "The message key was already used for different input; nothing was sent", {
				execution: "not-sent",
			});
		if (earlier.phase === "uncertain")
			throw new RpcError(ERR.unavailable, "The session could not take the message", {
				execution: "uncertain",
				id: earlier.messageId,
				queued: earlier.queued,
			});
		if (earlier.phase === "accepted") return { id: earlier.messageId, queued: earlier.queued, key };
	}
	const busy = !ctx.isIdle() || ctx.hasPendingMessages() || host.receipts.busy;
	if (requireIdle && busy)
		throw new RpcError(ERR.unavailable, "The session is busy; nothing was sent", { execution: "not-sent" });
	host.receipts.assertRoom(key);
	const id = host.nextId();
	const deliverAs = mode === "followUp" ? "followUp" : "steer";
	const at = Date.now();
	const accepted = { id, queued: busy ? deliverAs : "turn" };
	const { receipt, waiter } = host.receipts.open(fingerprint, accepted, key, busy, callerOwner(caller));
	const message: MessageEnvelope = {
		channel: "external",
		direction: "inbound",
		from,
		to: originalSessionId,
		text: raw,
		id,
	};
	const deadline = Date.now() + timeout;
	const preparingTimer = setTimeout(
		() => host.receipts.cancelPreparation(receipt, preparationExpired(receipt)),
		timeout,
	);
	preparingTimer.unref();
	let external = externalFacts(from, caller, host.transport, wait, replyRequired, host.agents.list());
	// Every message is held to the ceiling, also one that steers or queues behind running work: the run it joins, the
	// user's own included, runs under it until the session settles, so timing a message never yields the session's full mode.
	let capped: TurnCeiling | undefined;
	const callerCeiling = sessionApiTurnCeiling();
	let announceAsking!: () => void;
	const asking = new Promise<void>((resolve) => {
		announceAsking = resolve;
	});
	const delivery = (async (): Promise<void> => {
		let text = "";
		let outcome: "not-sent" | "refused" | "dispatched" = "not-sent";
		try {
			// The call's own wait bounds the call back to the instance the caller names.
			if (host.verify)
				external = await Promise.race([host.verify(external, timeout), receipt.settlement.then(() => external)]);
			if (host.operations.messageSend)
				await Promise.race([host.operations.messageSend(message, ctx, receipt.controller.signal), receipt.settlement]);
			if (host.operations.admit) {
				outcome = "refused";
				const onAsk = () => {
					receipt.waitingForUser = true;
					if (!key) host.receipts.adopt(receipt, id);
					host.log.publish("external.message", { id, from, caller, status: "waiting-for-user" });
					announceAsking();
				};
				await Promise.race([
					host.operations.admit(admission(external, whole, callerCeiling), ctx, receipt.controller.signal, onAsk),
					receipt.settlement,
				]);
				outcome = "not-sent";
			}
			guardPreparedSend(host, params, ctx, originalSessionId, key, receipt);
			const given = host.agents.deliverable(whole, from);
			if (typeof given !== "string") throw new RpcError(ERR.unavailable, given.error);
			text = given;
			clearTimeout(preparingTimer);
			// A run may have ended or begun while the message was prepared (or the user decided): it is queued or starts a turn as the session is now.
			const queued = !ctx.isIdle() || ctx.hasPendingMessages() ? deliverAs : "turn";
			host.receipts.accept(receipt, waiter, key !== undefined || wait, queued, key);
			outcome = "dispatched";
			const settlementVersion = host.receipts.settlementVersion;
			// The turn this call starts runs its tools under the ceiling until the session settles; read now, not at the first check, so a refused or failed hand-off can release it.
			// Only the turn this call starts is released on a failed hand-off; a run it joined keeps the ceiling until it settles.
			const ceiling = sessionApiTurnCeiling();
			if (ceiling) host.operations.capTurn?.(ceiling);
			if (ctx.isIdle() && !ctx.hasPendingMessages()) capped = ceiling;
			const sending = host.api.session.sendMessage(
				{
					customType: EXTERNAL_MESSAGE_TYPE,
					content: externalContent(external, text, at),
					display: true,
					details: { id, from, at, message, external },
				},
				{ triggerTurn: true, deliverAs },
			);
			// sendMessage may encompass the whole turn, so non-waiting callers cannot await it. An asynchronous rejection
			// still invalidates an unsettled handoff, and the keyed receipt must prevent an unsafe second dispatch.
			void Promise.resolve(sending).catch((error: unknown) => {
				if (receipt.phase !== "accepted" || host.receipts.settlementVersion !== settlementVersion) return;
				if (capped) host.operations.capTurn?.(undefined);
				// A replaced/stopped session has forgotten this receipt; never record its late failure in the new session.
				let current: FeatureContext;
				try {
					current = host.session();
				} catch {
					return;
				}
				if (
					current !== ctx ||
					current.sessionManager.getSessionId() !== originalSessionId ||
					(key && host.receipts.get(key) !== receipt)
				)
					return;
				const failure = new RpcError(
					ERR.unavailable,
					`The session could not take the message: ${errorMessage(error)}`,
					{ execution: "uncertain", ...accepted },
				);
				host.receipts.fail(receipt, waiter, key, failure, "dispatched");
				try {
					host.audit({ method: "message.send.failed", id, from, execution: "uncertain" });
					host.log.publish("external.message", { id, from, execution: "uncertain", status: "failed" });
				} catch {
					// Audit/streaming is best effort after the receipt has been rejected.
				}
			});
			receipt.resolveReady();
		} catch (error) {
			clearTimeout(preparingTimer);
			if (capped) host.operations.capTurn?.(undefined);
			const dispatched = outcome === "dispatched";
			const failure = new RpcError(ERR.unavailable, `The session could not take the message: ${errorMessage(error)}`, {
				execution: dispatched ? "uncertain" : "not-sent",
				...(dispatched ? accepted : {}),
			});
			host.receipts.fail(receipt, waiter, key, failure, outcome);
			if (outcome === "refused") host.log.publish("external.message", { id, from, caller, status: "refused" });
			throw failure;
		}
		host.audit({
			method: "message.send",
			id,
			from,
			caller,
			callerVerified: external.verified === true,
			...(capped ? { turnPermission: capped } : {}),
			mode: deliverAs,
			queued: accepted.queued,
			chars: whole.length,
		});
		host.log.publish("external.message", {
			id,
			from,
			caller,
			callerVerified: external.verified === true,
			transport: host.transport,
			text: redactSecrets(capChars(text, 2_000)),
			queued: accepted.queued,
		});
	})();
	if (!wait) {
		// A caller that does not wait hears at once that the user decides; a retry with its key gets the outcome.
		// A keyed one is also acknowledged when its preparation outlasts the acknowledgement window: the receipt holds
		// the message, and a retry with the key gets the outcome instead of dispatching it again.
		let ackTimer: NodeJS.Timeout | undefined;
		const slow = new Promise<"slow">((resolve) => {
			if (key) ackTimer = setTimeout(() => resolve("slow"), Math.min(SEND_ACK_MS, timeout));
		});
		const early = await Promise.race([
			delivery.then(() => undefined),
			asking.then(() => WAITING_FOR_USER),
			slow.then(() => PREPARING),
		]).finally(() => clearTimeout(ackTimer));
		if (early) {
			delivery.catch(() => undefined);
			return { ...accepted, queued: early, key: key ?? id };
		}
		return accepted;
	}
	await delivery;
	try {
		return { ...accepted, ...(await host.receipts.wait(receipt, Math.max(1, deadline - Date.now()))) };
	} finally {
		if (!key) host.receipts.release(waiter);
	}
}

function guardPreparedSend(
	host: SendHost,
	params: Record<string, unknown>,
	original: FeatureContext,
	sessionId: string,
	key: string | undefined,
	receipt: SendReceipt,
): void {
	const ctx = host.session();
	host.guardSession(params, ctx);
	if (ctx !== original || ctx.sessionManager.getSessionId() !== sessionId)
		throw new RpcError(ERR.unavailable, "The session was replaced; nothing was sent");
	if (receipt.phase !== "preparing")
		throw new RpcError(ERR.unavailable, "Message preparation was cancelled; nothing was sent");
	if (
		params.requireIdle === true &&
		(!ctx.isIdle() || ctx.hasPendingMessages() || host.receipts.activeKey !== key || host.receipts.preparingCount > 1)
	) {
		throw new RpcError(ERR.unavailable, "The session became busy; nothing was sent");
	}
}
