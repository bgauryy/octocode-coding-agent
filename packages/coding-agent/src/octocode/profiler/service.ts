import fs from "node:fs";
import type {
	ProfileAgent,
	ProfileAgents,
	ProfileInsights,
	ProfileMessage,
	ProfileRequests,
	ProfileTimeline,
	ProfileUpdate,
} from "@octocodeai/octocode-contracts/profiler";
import type { Traffic } from "@octocodeai/octocode-contracts/team";
import { deriveInsights } from "./insights.ts";
import { allEvents, deriveTimeline, type Lane } from "./timeline.ts";
import { toChromeTrace, type ChromeTrace } from "./trace.ts";
import { agentRow, deriveRequests, type ProfilerMember } from "./derive.ts";
import { withContext, type AgentContext } from "./context.ts";
import { parseTranscript, prepare, type Prepared } from "./entries.ts";
import { SessionCodec } from "../../core/session-manager/codec.ts";
import { reportToStderr } from "../../../../common/src/stderr.ts";

/** What a server needs from the profiler; both /web servers (and the daemon, through the attach protocol) use it. */
export interface ProfilerPort {
	agents(): ProfileAgents;
	/** The agent's requests after `after`; undefined for an id that is not one of this session's agents. */
	requests(agentId: string, after?: number, detail?: boolean): ProfileRequests | undefined;
	/** Calls `listener` when a listed agent finishes a request; returns the way to stop. */
	subscribe(listener: (update: ProfileUpdate) => void): () => void;
	timeline(since?: number): ProfileTimeline;
	insights(): ProfileInsights;
	trace(): ChromeTrace;
}

export type { ProfilerMember };

/** Where the profiler reads from: the session's own agent and descendants, as the workspace snapshot lists them. */
export interface ProfilerSource {
	sessionId: string;
	/** The coordinator's team row, with the model and status it reports. */
	self(): ProfilerMember | undefined;
	coordinatorFile(): string | undefined;
	members(): ProfilerMember[];
	/** The team's messages that involve this session or its agents. */
	traffic(): Traffic[];
	/** The transcript of a listed agent: the session file its team row resolves to; undefined when none can be read. */
	transcript(agentId: string): string | undefined;
	/**
	 * The context window an agent compacts against for a model (the working budget, not the catalog capacity).
	 * Absent for stored sources: their agents list without a window.
	 */
	contextWindowOf?(provider: string, model: string): number | undefined;
	/** Whether the session behind the source has closed; a failing check then ends live updates without a report. */
	closed?(): boolean;
}

/** How often a subscribed profiler checks the transcripts of its agents (a stat each, reading only what was appended). */
const POLL_MS = 1000;
/** A transcript larger than this is listed without requests instead of being held in memory. */
const MAX_BYTES = 256 * 1024 * 1024;
/** Live frames sent per agent and check; older unseen requests stay available through the route. */
const MAX_FRAMES = 5;

interface Parsed {
	size: number;
	mtimeMs: number;
	/** Bytes of `size` that ended in a newline: appended text is parsed from here. */
	offset: number;
	prepared: Prepared;
	/** Has read the lines up to `offset`, so appended lines stored against them read whole. */
	codec: SessionCodec;
}

/**
 * Parses transcripts once per file state: a file that only grew is read from where the last parse stopped, an
 * unchanged one is not read at all, so repeated polls cost a stat each.
 */
class TranscriptCache {
	private readonly files = new Map<string, Parsed>();

	load(file: string): Prepared | undefined {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			this.files.delete(file);
			return undefined;
		}
		if (stat.size > MAX_BYTES) return undefined;
		const known = this.files.get(file);
		if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.prepared;
		const grown = known !== undefined && stat.size > known.offset;
		const start = grown ? known.offset : 0;
		let text: string;
		try {
			const fd = fs.openSync(file, "r");
			try {
				const buffer = Buffer.alloc(stat.size - start);
				fs.readSync(fd, buffer, 0, buffer.length, start);
				text = buffer.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			this.files.delete(file);
			return undefined;
		}
		const complete = text.lastIndexOf("\n") + 1;
		const codec = grown ? known.codec : new SessionCodec();
		const entries = [...(grown ? known.prepared.entries : []), ...parseTranscript(text.slice(0, complete), codec)];
		const prepared = prepare(entries);
		this.files.set(file, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			offset: start + Buffer.byteLength(text.slice(0, complete)),
			prepared,
			codec,
		});
		return prepared;
	}
}

/** The analysis of one session: agents, requests, timeline, insights and trace over the same transcripts and traffic. */
export function createProfiler(
	source: ProfilerSource,
	cache = new TranscriptCache(),
): ProfilerPort & { close(): void } {
	const listeners = new Set<(update: ProfileUpdate) => void>();
	let timer: ReturnType<typeof setInterval> | undefined;
	const seen = new Map<string, number>();
	const knownEvents = new Set<string>();
	const knownMessages = new Map<number, string>();
	const shown = new Map<string, string>();
	const breakdowns: AgentContext["cache"] = new Map();
	let primed = false;

	const listed = (): Array<{ base: ProfilerMember; prepared: Prepared | undefined }> => {
		const self = source.self();
		const file = source.coordinatorFile();
		const rows = self ? [{ base: self, prepared: file ? cache.load(file) : undefined }] : [];
		for (const base of source.members()) {
			const path = source.transcript(base.id);
			rows.push({ base, prepared: path ? cache.load(path) : undefined });
		}
		return rows;
	};
	const rowOf = (base: ProfilerMember, prepared: Prepared | undefined, traffic: Traffic[], now: number): ProfileAgent =>
		withContext(agentRow(base, prepared), {
			member: base,
			prepared,
			traffic,
			now,
			contextWindowOf: source.contextWindowOf?.bind(source),
			cache: breakdowns,
		});
	const lanes = (rows: ReturnType<typeof listed>): Lane[] =>
		rows.map(({ base, prepared }) => ({
			id: base.id,
			...(base.parentId ? { parentId: base.parentId } : {}),
			...(base.joinedAt ? { joinedAt: base.joinedAt } : {}),
			...(base.outcome ? { endedAt: base.updatedAt, outcome: base.outcome } : {}),
			prepared,
		}));
	const timelineInput = () => ({
		sessionId: source.sessionId,
		lanes: lanes(listed()),
		traffic: source.traffic(),
		now: Date.now(),
	});

	const frames = (): ProfileUpdate[] => {
		const rows = listed();
		const traffic = source.traffic();
		const now = Date.now();
		const { events, messages } = allEvents({
			sessionId: source.sessionId,
			lanes: lanes(rows),
			traffic,
			now,
		});
		const freshEvents = events.filter((event) => !knownEvents.has(event.id));
		const freshMessages = messages.filter((message) => knownMessages.get(message.id) !== message.state);
		for (const event of freshEvents) knownEvents.add(event.id);
		for (const message of freshMessages) knownMessages.set(message.id, message.state);
		const updates: ProfileUpdate[] = [];
		for (const { base, prepared } of rows) {
			const count = prepared?.requests.length ?? 0;
			const before = seen.get(base.id);
			seen.set(base.id, count);
			const from = before ?? (primed ? 0 : count);
			const mine = freshEvents.filter((event) => event.agentId === base.id && event.kind !== "request");
			const sent: ProfileMessage[] = freshMessages.filter(
				(message) =>
					message.from === base.id || (!rows.some((r) => r.base.id === message.from) && message.to[0] === base.id),
			);
			const agent = rowOf(base, prepared, traffic, now);
			// Status, activity and context change without a new request: they get a frame of their own.
			const state = JSON.stringify(agent);
			const moved = shown.get(base.id) !== state;
			shown.set(base.id, state);
			if (!prepared || (count <= from && !mine.length && !sent.length)) {
				if (moved && primed) updates.push({ agent });
				continue;
			}
			const requests = deriveRequests(prepared.entries, {
				agentId: base.id,
				after: Math.max(from, count - MAX_FRAMES) - 1,
				limit: MAX_FRAMES,
				prepared,
			}).filter((r) => r.index >= from);
			if (!requests.length)
				updates.push({ agent, ...(mine.length ? { events: mine } : {}), ...(sent.length ? { messages: sent } : {}) });
			requests.forEach((request, i) => {
				const last = i === requests.length - 1;
				updates.push({
					agent,
					request,
					...(last && mine.length ? { events: mine } : {}),
					...(last && sent.length ? { messages: sent } : {}),
				});
			});
		}
		return updates;
	};

	let failing = false;
	const tick = () => {
		try {
			const updates = frames();
			if (primed) for (const update of updates) for (const listener of listeners) listener(update);
			primed = true;
			failing = false;
		} catch (error) {
			// A closed session ends the poll; the server that subscribed is closing too. Any other failure is reported once
			// per run of failures and the next check tries again, so one bad read does not end live updates for good.
			if (source.closed?.()) return stop();
			if (!failing) reportToStderr("Profiler: checking the agents failed; retrying every second.", error);
			failing = true;
		}
	};
	const stop = () => {
		clearInterval(timer);
		timer = undefined;
	};

	return {
		agents: () => {
			const generatedAt = Date.now();
			const traffic = source.traffic();
			const agents = listed().map(({ base, prepared }) => rowOf(base, prepared, traffic, generatedAt));
			const starts = agents.flatMap((agent) => (agent.startedAt ? [agent.startedAt] : []));
			return {
				sessionId: source.sessionId,
				agents,
				startedAt: starts.length ? Math.min(...starts) : generatedAt,
				generatedAt,
			};
		},
		requests: (agentId, after, detail) => {
			const self = source.self();
			const base = self?.id === agentId ? self : source.members().find((member) => member.id === agentId);
			if (!base) return undefined;
			const file = self?.id === agentId ? source.coordinatorFile() : source.transcript(agentId);
			const prepared = file ? cache.load(file) : undefined;
			if (!prepared) return { agentId, requests: [], hasMore: false };
			const requests = deriveRequests(prepared.entries, { agentId, after, detail, prepared });
			const next = (requests.at(-1)?.index ?? after ?? -1) + 1;
			return { agentId, requests, hasMore: next < prepared.requests.length };
		},
		timeline: (since) => deriveTimeline(timelineInput(), since),
		insights: () => {
			const input = timelineInput();
			const { events, messages } = allEvents(input);
			return deriveInsights({ sessionId: input.sessionId, lanes: input.lanes, events, messages, now: input.now });
		},
		trace: () => {
			const input = timelineInput();
			const { events, messages } = allEvents(input);
			return toChromeTrace(
				input.lanes.map((lane) => lane.id),
				events,
				messages,
			);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			if (!timer) {
				seen.clear();
				shown.clear();
				knownEvents.clear();
				knownMessages.clear();
				primed = false;
				tick();
				timer ??= setInterval(tick, POLL_MS);
				timer.unref();
			}
			return () => {
				listeners.delete(listener);
				if (!listeners.size) stop();
			};
		},
		close: () => {
			listeners.clear();
			stop();
		},
	};
}
