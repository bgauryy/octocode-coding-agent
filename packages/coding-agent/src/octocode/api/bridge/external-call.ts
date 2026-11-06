import type { ExtensionContext } from "../../../core/features/index.ts";
import { asRecord, errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { redactData, redactSecrets } from "../../../../../common/src/sanitize.ts";
import { ERR, RpcError } from "../protocol.ts";
import { boundedExternal } from "./bounded.ts";
import type { TurnCeilings } from "./ceiling.ts";

/**
 * `external.call`: the registered external-agent operation, held to the session API's turn ceiling while it runs. A
 * failure becomes an RPC error that carries the bounded, redacted evidence the call left (partial output, stderr).
 */
export async function callExternal(
	ceilings: TurnCeilings,
	params: unknown,
	session: () => ExtensionContext,
): Promise<unknown> {
	const { operations } = ceilings;
	if (!operations.externalCall) throw new RpcError(ERR.unavailable, "External agents are not registered");
	try {
		return boundedExternal(await ceilings.hold(async () => operations.externalCall!(params, session())));
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
