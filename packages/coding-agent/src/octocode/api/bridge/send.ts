import type { ExtensionAPI, ExtensionContext } from "../../../core/features/index.ts";
import { sha256 } from "../../../../../common/src/atomic-file.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { apiClientLabel, fenceUntrusted, headerText, messageHeader } from "../../shared/fence.ts";
import { EXTERNAL_MESSAGE_TYPE, EXTERNAL_SENDER, type MessageEnvelope, USER_SENDER } from "../../shared/messages.ts";
import { redactSecrets, visibleControls } from "../../../../../common/src/sanitize.ts";
import { capChars } from "../../shared/util.ts";
import type { EventLog } from "../events.ts";
import { ERR, MESSAGE_KEY_MAX, numberParam, RpcError, stringParam, WAIT_MS } from "../protocol.ts";
import type { SendReceipt, SendReceipts } from "../receipts.ts";
import type { AgentDirectory, ApiOperations } from "./contracts.ts";

/** Senders a client may not claim: the user, the team's own API sender, and (checked per call) any live agent. */
const RESERVED_SENDERS = new Set([USER_SENDER, EXTERNAL_SENDER]);

/** What `message.send` needs of the API it runs in; `OctocodeApi` passes its own state and checks. */
interface SendHost {
	readonly api: ExtensionAPI;
	readonly agents: AgentDirectory;
	readonly operations: ApiOperations;
	readonly receipts: SendReceipts;
	readonly log: EventLog;
	/** The bound session; throws when there is none. */
	session(): ExtensionContext;
	/** Refuses a call whose `expectedSessionId` no longer names the session. */
	guardSession(params: Record<string, unknown>, ctx: ExtensionContext): void;
	/** The next message id (`x1`, `x2`, …). */
	nextId(): string;
	/** Records an API-started turn in the session. */
	audit(data: Record<string, unknown>): void;
}

/** The sender name a client gave, on one line; a name that would pass for the user, the team or a live agent is refused. */
function sender(host: SendHost, params: Record<string, unknown>): string {
	const given = stringParam(params, "from", { max: 64, optional: true });
	const from = headerText((given ?? "external client").replaceAll('"', " "), 64) || "external client";
	const taken = host.agents
		.list()
		.some((agent) => typeof agent === "object" && agent !== null && (agent as { id?: unknown }).id === from);
	if (RESERVED_SENDERS.has(from.toLowerCase()) || taken)
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
	const raw = stringParam(params, "text")!;
	const whole = visibleControls(raw);
	const mode = params.mode ?? "auto";
	if (mode !== "auto" && mode !== "steer" && mode !== "followUp")
		throw new RpcError(ERR.invalidParams, "mode must be auto, steer or followUp");
	if (params.requireIdle !== undefined && typeof params.requireIdle !== "boolean")
		throw new RpcError(ERR.invalidParams, "requireIdle must be a boolean");
	const requireIdle = params.requireIdle === true;
	const wait = params.wait === true;
	const timeout = numberParam(params, "timeoutMs", WAIT_MS) ?? WAIT_MS.default;
	const key = stringParam(params, "key", { optional: true, max: MESSAGE_KEY_MAX });
	const fingerprint = sha256(JSON.stringify({ raw, from, mode, requireIdle }));
	const prior = key ? host.receipts.get(key) : undefined;
	if (prior) {
		if (prior.fingerprint !== fingerprint)
			throw new RpcError(ERR.invalidParams, "The message key was already used for different input; nothing was sent", {
				execution: "not-sent",
			});
		if (wait) return { ...prior.accepted, ...(await host.receipts.wait(prior, timeout)) };
		await prior.ready;
		// `fail` records the failure whenever it marks a receipt uncertain.
		if (prior.phase === "uncertain") throw prior.failure!;
		return prior.accepted;
	}
	const busy = !ctx.isIdle() || ctx.hasPendingMessages() || host.receipts.busy;
	if (requireIdle && busy)
		throw new RpcError(ERR.unavailable, "The session is busy; nothing was sent", { execution: "not-sent" });
	host.receipts.assertRoom(key);
	let text: string;
	const id = host.nextId();
	const deliverAs = mode === "followUp" ? "followUp" : "steer";
	const at = Date.now();
	const accepted = { id, queued: busy ? deliverAs : "turn" };
	const { receipt, waiter } = host.receipts.open(fingerprint, accepted, key, busy);
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
		() => host.receipts.cancelPreparation(receipt, "Message preparation timed out; nothing was sent"),
		timeout,
	);
	preparingTimer.unref();
	let dispatched = false;
	try {
		if (host.operations.messageSend)
			await Promise.race([host.operations.messageSend(message, ctx, receipt.controller.signal), receipt.settlement]);
		guardPreparedSend(host, params, ctx, originalSessionId, key, receipt);
		const given = host.agents.deliverable(whole, from);
		if (typeof given !== "string") throw new RpcError(ERR.unavailable, given.error);
		text = given;
		clearTimeout(preparingTimer);
		host.receipts.accept(receipt, waiter, key !== undefined || wait);
		dispatched = true;
		const settlementVersion = host.receipts.settlementVersion;
		const sending = host.api.sendMessage(
			{
				customType: EXTERNAL_MESSAGE_TYPE,
				content: fenceUntrusted(messageHeader(apiClientLabel(from), at), text),
				display: true,
				details: { id, from, at, message },
			},
			{ triggerTurn: true, deliverAs },
		);
		// sendMessage may encompass the whole turn, so non-waiting callers cannot await it. An asynchronous rejection
		// still invalidates an unsettled handoff, and the keyed receipt must prevent an unsafe second dispatch.
		void Promise.resolve(sending).catch((error: unknown) => {
			if (receipt.phase !== "accepted" || host.receipts.settlementVersion !== settlementVersion) return;
			// A replaced/stopped session has forgotten this receipt; never record its late failure in the new session.
			let current: ExtensionContext;
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
			const failure = new RpcError(ERR.unavailable, `The session could not take the message: ${errorMessage(error)}`, {
				execution: "uncertain",
				...accepted,
			});
			host.receipts.fail(receipt, waiter, key, failure, true);
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
		const execution = dispatched ? "uncertain" : "not-sent";
		const failure = new RpcError(ERR.unavailable, `The session could not take the message: ${errorMessage(error)}`, {
			execution,
			...(dispatched ? accepted : {}),
		});
		host.receipts.fail(receipt, waiter, key, failure, dispatched);
		throw failure;
	}
	host.audit({ method: "message.send", id, from, mode: deliverAs, queued: accepted.queued, chars: whole.length });
	host.log.publish("external.message", {
		id,
		from,
		text: redactSecrets(capChars(text, 2_000)),
		queued: accepted.queued,
	});
	if (!wait) return accepted;
	try {
		return { ...accepted, ...(await host.receipts.wait(receipt, Math.max(1, deadline - Date.now()))) };
	} finally {
		if (!key) host.receipts.release(waiter);
	}
}

function guardPreparedSend(
	host: SendHost,
	params: Record<string, unknown>,
	original: ExtensionContext,
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
