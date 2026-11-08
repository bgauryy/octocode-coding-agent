import type { ExtensionContext } from "../../../core/features/index.ts";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { redactData, redactSecrets } from "../../../../../common/src/sanitize.ts";
import { ERR, RpcError } from "../protocol.ts";
import { boundedExternal } from "./bounded.ts";
import type { Connection } from "../server.ts";
import { admission, callerFrom, type ExternalFacts, externalFacts } from "./caller.ts";
import type { TurnCeilings } from "./ceiling.ts";
import { recordRead } from "./reads.ts";

/** What `external.call` needs of the API it runs in; `OctocodeApi` passes its own state. */
export interface ExternalCallHost {
	readonly ceilings: TurnCeilings;
	/** The bound session; throws when there is none. */
	session(): ExtensionContext;
	/** The caller's facts, verified with the instance it names when it names one (`bridge/verify.ts`). */
	verify(facts: ExternalFacts, params: Record<string, unknown>, connection: Connection): Promise<ExternalFacts>;
	/** Records what an API client did in the session. */
	audit(data: Record<string, unknown>): void;
}

/**
 * `external.call`: the registered external-agent operation, held to the session API's turn ceiling while it runs. An
 * outside process asks this session to start, drive or stop an agent, so `connect`, `prompt`, `cancel` and `disconnect`
 * are admitted first as an external message (`message.external`, as `message.send` is): taken in `full`, asked in other
 * modes and refused with nobody to ask. `list` only reads, so it follows the read rule: open, and recorded naming the
 * caller. A failure becomes an RPC error that carries the bounded, redacted evidence the call left (partial output, stderr).
 */
export async function callExternal(
	host: ExternalCallHost,
	params: Record<string, unknown>,
	connection: Connection,
): Promise<unknown> {
	const { ceilings } = host;
	const { operations } = ceilings;
	if (!operations.externalCall) throw new RpcError(ERR.unavailable, "External agents are not registered");
	if (params.action === "list") recordRead((data) => host.audit(data), "external.call", params, connection);
	else {
		const claim = externalFacts("external client", callerFrom(params), connection.transport, false);
		const facts = await host.verify(claim, params, connection);
		// The ticket goes back to the claimed instance only (`bridge/verify.ts`): the dialog and the audit never show it.
		const caller = isRecord(params.caller) ? { ...params.caller, ticket: undefined } : params.caller;
		const request = JSON.stringify(redactData({ ...params, caller }));
		await operations.admit?.(admission(facts, request, ceilings.current()), host.session()).catch((error: unknown) => {
			throw new RpcError(ERR.unavailable, errorMessage(error), { execution: "not-sent" });
		});
	}
	try {
		return boundedExternal(await ceilings.hold(async () => operations.externalCall!(params, host.session())));
	} catch (error) {
		const details = asRecord(error);
		const data = Object.fromEntries(
			["partial", "execution", "stderr"].filter((key) => details[key] !== undefined).map((key) => [key, details[key]]),
		);
		const evidence = boundedExternal(data);
		const visible =
			isRecord(evidence) && evidence.fullOutput
				? { ...redactData({ execution: data.execution }), ...evidence }
				: evidence;
		throw new RpcError(ERR.unavailable, redactSecrets(errorMessage(error)), visible);
	}
}
