import fs from "node:fs";
import { agentEvents } from "../../../../../db/src/api.ts";
import { openAgentDb } from "../../../storage/database.ts";
import { agentDbPath } from "../../../storage/state-paths.ts";
import { readWorkspaceIdentity } from "../../../storage/workspace.ts";
import { openWorkspaceDb } from "../../../storage/workspace-database.ts";

export const EVENTS_LIMIT = { min: 1, max: 1000, default: 200 } as const;

/** What another host sees of one lifecycle event: on (an agent joined), state (it changed), off (it left, and why). */
interface LifecycleLine {
	seq: number;
	time: string;
	event: "on" | "state" | "off";
	agent: string;
	role?: string;
	parent?: string;
	session?: string;
	state?: string;
	changes?: Record<string, unknown>;
	reason?: string;
	detail?: string;
	outcome?: unknown;
	backlogItem?: unknown;
	stats?: Record<string, unknown>;
}

const NAMES = { create: "on", update: "state", delete: "off" } as const;
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** One event as the command reports it. The numbers of a `delete` are the agent's last heartbeat. */
function describeEvent(row: agentEvents.EventRow): LifecycleLine {
	const { data } = row;
	const stats =
		row.type === "delete"
			? Object.fromEntries(
					["toolCalls", "input", "cacheRead", "output", "cost"].flatMap((key) =>
						data[key] === undefined ? [] : [[key, data[key]]],
					),
				)
			: undefined;
	const changes =
		data.changes && typeof data.changes === "object" ? (data.changes as Record<string, unknown>) : undefined;
	return {
		seq: row.seq,
		time: row.time,
		event: NAMES[row.type as keyof typeof NAMES],
		agent: row.name ?? "-",
		...(text(data.role) ? { role: text(data.role) } : {}),
		...(row.parentId ? { parent: row.parentId } : {}),
		...(row.sessionId ? { session: row.sessionId } : {}),
		...(text(data.state) ? { state: text(data.state) } : {}),
		...(changes ? { changes } : {}),
		...(text(data.reason) ? { reason: text(data.reason) } : {}),
		...(text(data.detail) ? { detail: text(data.detail) } : {}),
		...(data.outcome !== undefined ? { outcome: data.outcome } : {}),
		...(data.backlogItem !== undefined ? { backlogItem: data.backlogItem } : {}),
		...(stats && Object.keys(stats).length ? { stats } : {}),
	};
}

function textLine(line: LifecycleLine): string {
	const parts = [String(line.seq), line.time, line.event.padEnd(5), line.agent, line.role ?? "-"];
	if (line.parent) parts.push(`parent=${line.parent}`);
	if (line.state) parts.push(`state=${line.state}`);
	if (line.changes) parts.push(`changed=${Object.keys(line.changes).join(",")}`);
	if (line.reason) parts.push(`reason=${line.reason}`);
	if (line.detail) parts.push(`detail=${JSON.stringify(line.detail)}`);
	if (line.stats)
		parts.push(
			Object.entries(line.stats)
				.map(([key, value]) => `${key}=${String(value)}`)
				.join(" "),
		);
	return parts.join("\t");
}

/**
 * `octocode-api events`: the agent lifecycle events of this directory's workspace after `since`, read from the agent
 * database without a running session. The last sequence is the cursor for the next call. Nothing is created: a missing
 * database or a directory Octocode never ran in has no events.
 */
export function eventsReport(
	options: { since: number; limit: number; json: boolean; cwd: string },
	env: NodeJS.ProcessEnv = process.env,
): { output: string; notice?: string } {
	const empty = (notice: string) => report([], notice);
	const report = (rows: agentEvents.EventRow[], notice?: string) => {
		const events = rows.map(describeEvent);
		const last = rows.at(-1)?.seq ?? options.since;
		const output = options.json
			? JSON.stringify({ since: options.since, last, events })
			: [...events.map(textLine), `last seq: ${last}`].join("\n");
		return { output, ...(notice ? { notice } : {}) };
	};
	const file = agentDbPath(env);
	if (!fs.existsSync(file)) return empty(`No agent database at ${file}.`);
	const workspace = readWorkspaceIdentity(options.cwd);
	if (!workspace) return empty(`No Octocode workspace in ${options.cwd}.`);
	const machine = openAgentDb(file, env);
	try {
		const { agent } = openWorkspaceDb(machine, workspace, env);
		try {
			return report(agentEvents.since(agent.db, options.since, { workspaces: [workspace.id] }, options.limit));
		} finally {
			if (agent !== machine) agent.close();
		}
	} finally {
		machine.close();
	}
}
