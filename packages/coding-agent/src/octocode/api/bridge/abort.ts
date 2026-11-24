import type { FeatureContext } from "../../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { ERR, MESSAGE_KEY_MAX, RpcError, stringParam } from "../protocol.ts";
import type { SendReceipts } from "../receipts.ts";
import type { Connection } from "../server.ts";
import { admission, callerFrom, callerOwner, type ExternalFacts, externalFacts } from "./caller.ts";
import type { TurnCeilings } from "./ceiling.ts";

/** What `turn.abort` needs of the API it runs in; `OctocodeApi` passes its own state. */
export interface AbortHost {
	readonly ceilings: TurnCeilings;
	readonly receipts: SendReceipts;
	/** The bound session; throws when there is none. */
	session(): FeatureContext;
	/** Refuses a call whose `expectedSessionId` no longer names the session. */
	guardSession(params: Record<string, unknown>, ctx: FeatureContext): void;
	/** The caller's facts, verified with the instance it names when it names one (`bridge/verify.ts`). */
	verify(facts: ExternalFacts, params: Record<string, unknown>, connection: Connection): Promise<ExternalFacts>;
	/** Records what an API client did in the session. */
	audit(data: Record<string, unknown>): void;
}

/**
 * `turn.abort`: stopping the session's running turn is admitted like a message (`message.external`): taken in `full`, asked
 * in the other modes, refused with nobody to ask, and answered by a verified process's grant or denial. Withdrawing the
 * caller's own message while it is still being prepared stops no work, and an idle session with nothing queued has nothing
 * to stop: neither asks. An answer can come long after the call (its caller may have timed out), so the run is noted
 * before admission: if it settled meanwhile, the run going now is another one, which this call never asked to stop.
 */
export async function abortTurn(
	host: AbortHost,
	params: Record<string, unknown>,
	connection: Connection,
): Promise<unknown> {
	const ctx = host.session();
	host.guardSession(params, ctx);
	const key = stringParam(params, "key", { optional: true, max: MESSAGE_KEY_MAX });
	const owner = key !== undefined && host.receipts.abort(key, callerOwner(callerFrom(params)));
	if (owner === "cancelled") return { aborted: false, cancelledPreparation: true };
	// A run its owner's key names may not have started yet (accepted, before `agent_start`): that one is stopped too.
	if (!owner && ctx.isIdle() && !ctx.hasPendingMessages() && !host.receipts.busy) return { aborted: false };
	const run = host.receipts.settlementVersion;
	const caller = callerFrom(params);
	const facts = await host.verify(
		externalFacts("external client", caller, connection.transport, false),
		params,
		connection,
	);
	const { operations } = host.ceilings;
	await operations
		.admit?.(admission(facts, "Stop the turn this session is running.", host.ceilings.current()), ctx)
		.catch((error: unknown) => {
			throw new RpcError(ERR.unavailable, errorMessage(error), { execution: "not-sent" });
		});
	if (host.session() !== ctx)
		throw new RpcError(ERR.unavailable, "The session was replaced while its user decided; nothing was stopped", {
			execution: "not-sent",
		});
	if (host.receipts.settlementVersion !== run) {
		host.audit({ method: "turn.abort", caller, callerVerified: facts.verified === true, settled: true });
		return {
			aborted: false,
			settled: true,
			message: "The run this call asked to stop ended while the user decided; nothing was stopped.",
		};
	}
	const wasBusy = !ctx.isIdle();
	ctx.abort();
	host.audit({ method: "turn.abort", caller, callerVerified: facts.verified === true });
	return { aborted: wasBusy };
}
