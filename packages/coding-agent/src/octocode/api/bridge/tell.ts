import type { ExtensionContext } from "../../../core/features/index.ts";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { ERR, RpcError, stringParam } from "../protocol.ts";
import type { Connection } from "../server.ts";
import { admission, callerFrom, type ExternalFacts, externalFacts } from "./caller.ts";
import type { TurnCeilings } from "./ceiling.ts";
import type { AgentDirectory } from "./contracts.ts";

/** What `agents.tell` needs of the API it runs in; `OctocodeApi` passes its own state. */
export interface TellHost {
	readonly agents: AgentDirectory;
	readonly ceilings: TurnCeilings;
	/** The bound session; throws when there is none. */
	session(): ExtensionContext;
	/** Records an API-started turn in the session. */
	audit(data: Record<string, unknown>): void;
	/** The caller's facts, verified with the instance it names when it names one (`bridge/verify.ts`). */
	verify(facts: ExternalFacts, params: Record<string, unknown>, connection: Connection): Promise<ExternalFacts>;
}

/** The ids of the team members this process runs: a message to one of them starts a turn here. */
function ownMembers(agents: AgentDirectory): Set<string> {
	return new Set(
		agents
			.list()
			.filter((member) => isRecord(member) && member.pid === process.pid && typeof member.id === "string")
			.map((member) => (member as { id: string }).id),
	);
}

/**
 * `agents.tell`: admitted as an external message, then sent through the team (a long text is the team's to save and point
 * to); a refusal (unknown agent, nobody reachable) is an RPC error. When it reaches a member this process runs (named, or
 * through "all"), the turn it starts is held to the `sessionApiTurnPermission` ceiling, as `message.send` holds its own.
 */
export async function tellAgent(
	host: TellHost,
	params: Record<string, unknown>,
	connection: Connection,
): Promise<unknown> {
	const to = stringParam(params, "to")!;
	const text = visibleControls(stringParam(params, "text")!);
	const claim = externalFacts("external client", callerFrom(params), connection.transport, false);
	const facts = await host.verify(claim, params, connection);
	const { operations } = host.ceilings;
	await operations.admit?.(admission(facts, text, host.ceilings.current()), host.session()).catch((error: unknown) => {
		throw new RpcError(ERR.unavailable, errorMessage(error), { execution: "not-sent" });
	});
	const result = await host.agents.tell(to, text);
	const refusal = isRecord(result) && typeof result.error === "string" ? result.error : undefined;
	const sent = isRecord(result) && Array.isArray(result.sent) ? result.sent : [];
	const own = ownMembers(host.agents);
	const ceiling = host.ceilings.current();
	// Released when the session settles (`agent_settled` in `bridge.ts`), as for a turn `message.send` started.
	if (ceiling && !refusal && sent.some((id) => own.has(id as string))) operations.capTurn?.(ceiling);
	host.audit({ method: "agents.tell", to, chars: text.length, accepted: !(isRecord(result) && "error" in result) });
	if (refusal !== undefined) throw new RpcError(ERR.invalidParams, refusal);
	return result;
}
