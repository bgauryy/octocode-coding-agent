import type { ProfileFinding } from "@octocodeai/octocode-contracts";
import { agentEvents, type Db } from "../../../../db/src/api.ts";

/** One stretch an agent went silent (no heartbeat), as its lifecycle event recorded it. */
export interface SilenceEpisode {
	id: string;
	agentId: string;
	/** Epoch ms the episode was noticed. */
	at: number;
	/** The agent's working line when it went quiet (`Running bash: …`, `Thinking`). */
	activity?: string;
	/** `provider/model` the agent ran. */
	model?: string;
	/** Whole minutes of silence when noticed. */
	minutes?: number;
}

/** The session's silence episodes: `ids` names its agents, `since` (epoch ms) when its first run started. */
export function storedSilences(db: Db, ids: readonly string[], since = 0): SilenceEpisode[] {
	return agentEvents.silences(db, ids, since).map((row) => ({
		id: row.id,
		agentId: row.name ?? String(row.data.agentId),
		at: Date.parse(row.time),
		...(typeof row.data.activity === "string" ? { activity: row.data.activity } : {}),
		...(typeof row.data.model === "string" ? { model: row.data.model } : {}),
		...(typeof row.data.minutes === "number" ? { minutes: row.data.minutes } : {}),
	}));
}

/** A working line names one tool after `Running` or `Checking`; a working line without one waits on the model. */
const TOOL_LINE = /^(?:⚠ )?(?:Running|Checking) (?!\d+ tools\b)(\S+)/;

/** What the agent was waiting on when it went silent: the running tool, several tools, the model, or unknown. */
export function silenceTool(activity: string | undefined): string {
	if (!activity) return "unknown";
	const tool = TOOL_LINE.exec(activity)?.[1];
	if (tool) return tool.replace(/:$/, "");
	return /^(?:⚠ )?Running \d+ tools\b/.test(activity) ? "several tools" : "model";
}

/** The provider half of `provider/model`; the whole value when it has no provider. */
const providerOf = (model: string | undefined): string => (model ? model.split("/", 1)[0] : "unknown");

/** Five or more episodes, or 30 minutes of silence, behind one tool and provider is a defect worth chasing first. */
const HIGH_EPISODES = 5;
const HIGH_MINUTES = 30;

/** One finding per tool and provider the session's agents went silent behind, longest total silence first. */
export function silenceFindings(episodes: readonly SilenceEpisode[]): ProfileFinding[] {
	const groups = new Map<string, { tool: string; provider: string; episodes: SilenceEpisode[]; minutes: number }>();
	for (const episode of episodes) {
		const tool = silenceTool(episode.activity);
		const provider = providerOf(episode.model);
		const key = `${tool}\u0000${provider}`;
		const group = groups.get(key) ?? { tool, provider, episodes: [], minutes: 0 };
		group.episodes.push(episode);
		group.minutes += episode.minutes ?? 0;
		groups.set(key, group);
	}
	return [...groups.values()]
		.sort((a, b) => b.minutes - a.minutes || b.episodes.length - a.episodes.length)
		.map(({ tool, provider, episodes: list, minutes }) => {
			const agents = [...new Set(list.map((episode) => episode.agentId))];
			const behind = tool === "model" ? `waiting on ${provider}` : `in ${tool} on ${provider}`;
			return {
				id: `silence:${tool}:${provider}`,
				kind: "silence" as const,
				severity: list.length >= HIGH_EPISODES || minutes >= HIGH_MINUTES ? ("high" as const) : ("medium" as const),
				title: `${list.length} silent ${list.length === 1 ? "episode" : "episodes"} ${behind}, ${minutes} min`,
				detail: `${agents.join(", ")} stopped sending heartbeats ${behind}. A tool that hangs needs a timeout or progress output; a provider that stalls needs a request timeout or another model.`,
				...(agents.length === 1 ? { agentId: agents[0] } : {}),
				waitedMs: minutes * 60_000,
				evidence: list.map((episode) => ({ agentId: episode.agentId, event: episode.id })),
			};
		});
}
