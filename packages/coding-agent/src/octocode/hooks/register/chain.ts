import { AGENT_CHAIN_CHANNEL, type AgentChainNotice } from "../../shared/agent-chain.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { ExtensionAPI } from "../../../core/features/index.ts";

const AGENT = "agent:";
/** Chain links remembered for a hook that has not read them yet; a session starts few chains, so a small bound is enough. */
const REMEMBERED = 200;

const asNotice = (value: unknown): AgentChainNotice | undefined =>
	isRecord(value) &&
	(value.kind === "queued" || value.kind === "released" || value.kind === "held") &&
	typeof value.agent === "string" &&
	Array.isArray(value.after)
		? (value as unknown as AgentChainNotice)
		: undefined;

const remember = <T>(map: Map<string, T>, key: string, value: T): void => {
	map.delete(key);
	map.set(key, value);
	if (map.size > REMEMBERED) map.delete(map.keys().next().value as string);
};

/**
 * What the AgentOn and AgentOff hook inputs say about chains: the prerequisites a started child waited for (and the
 * event that released it), and the queued children an agent's end released or held. Fed by `AGENT_CHAIN_CHANNEL`.
 */
export class ChainLinks {
	private readonly started = new Map<string, { after: string[]; seq: number | null }>();
	private readonly releases = new Map<string, string[]>();
	private readonly holds = new Map<string, string[]>();

	/** Notes one chain notice. */
	note(notice: AgentChainNotice): void {
		const agents = (names: readonly string[]) =>
			names.filter((name) => name.startsWith(AGENT)).map((name) => name.slice(AGENT.length));
		if (notice.kind === "released") {
			remember(this.started, notice.agent, { after: notice.after, seq: notice.seq ?? null });
			for (const id of agents(notice.after))
				remember(this.releases, id, [...(this.releases.get(id) ?? []), notice.agent]);
		}
		if (notice.kind === "held")
			for (const id of agents(notice.failed)) remember(this.holds, id, [...(this.holds.get(id) ?? []), notice.agent]);
	}

	/** `AgentOn` fields for `agent`: only a child that was queued has them. */
	on(agent: string): Record<string, unknown> {
		const link = this.started.get(agent);
		return link ? { started_after: { prerequisites: link.after, seq: link.seq } } : {};
	}

	/** `AgentOff` fields for `agent`: the queued children its end released and held. */
	off(agent: string): Record<string, unknown> {
		return { releases: this.releases.get(agent) ?? [], holds: this.holds.get(agent) ?? [] };
	}
}

/** Calls `listener` for each chain notice on `events`; returns the unsubscribe. */
export function onChainNotice(
	events: ExtensionAPI["events"],
	listener: (notice: AgentChainNotice) => void,
): () => void {
	return events.on(AGENT_CHAIN_CHANNEL, (value) => {
		const notice = asNotice(value);
		if (notice) listener(notice);
	});
}
