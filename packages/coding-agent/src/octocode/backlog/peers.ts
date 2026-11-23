import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { backlog as backlogQueries } from "../../../../db/src/api.ts";
import type { DatabaseFollower } from "../shared/database-follower.ts";
import { BACKLOG_CHANGE_CHANNEL } from "../shared/backlog-change.ts";
import { BacklogBus } from "./bus.ts";
import { BACKLOG_LINE_TYPE, statusLine } from "./status-line.ts";
import { type BacklogOptions, openBacklog } from "./context.ts";
import { type PeerWake, PeerNotifier } from "./peer-notify.ts";
import type { RelatedView } from "./related.ts";
import type { BacklogStore } from "./store.ts";

/** The paths each other live agent reserves (the team's locks). */
export type Reservations = () => Array<{ agent: string; paths: readonly string[] }>;

const OPEN = ["backlog", "todo", "ongoing"] as const;

/** `related`'s reads of the board, the waits and the reservations, one listing each. */
export function boardView(
	store: BacklogStore,
	db: Parameters<typeof backlogQueries.itemWatchers>[0],
	reservations?: Reservations,
): RelatedView {
	return {
		item: (ref) => store.get(ref),
		dependents: (ref) => store.list({ dependsOn: [ref], states: [...OPEN] }).items,
		children: (parent) => store.list({ parentId: parent, states: [...OPEN] }).items,
		ongoing: () => store.list({ states: ["ongoing"] }).items,
		watchers: (refs, notifiedState) => backlogQueries.itemWatchers(db, store.repo, refs, notifiedState),
		reservations: () => reservations?.() ?? [],
	};
}

/** The wake gate as the notifier uses it, passed in by the composition: whether the last run wrote `ref`, and how a wake is sent. */
export interface PeerWakes {
	acted(ref: string): boolean;
	send(wake: PeerWake): void | Promise<void>;
}

/** What a started feed hands back: its FYI lines for the next turn, and how to stop it. */
export interface BacklogFeed {
	fyi(): string | undefined;
	stop(): void;
}

/**
 * Starts this session's follow of the backlog change feed: every audited change is announced on `BACKLOG_CHANGE_CHANNEL`
 * (the hooks domain listens), and the related-agent notifier turns the ones that concern items this session holds or
 * waits on into a wake or an FYI line. `follower` is the database follower the board already shares.
 */
export function startBacklogFeed(
	api: FeatureSetup,
	ctx: FeatureContext,
	options: BacklogOptions,
	follower: DatabaseFollower,
	reservations?: Reservations,
	wakes?: PeerWakes,
): BacklogFeed {
	const env = options.env ?? process.env;
	const backlog = openBacklog(ctx, options);
	const db = () => sharedAgentDb(env).db;
	const me = { session: backlog.session, agent: options.agentId?.() };
	const failed = (error: unknown) => {
		const text = `Backlog change feed: ${errorMessage(error)}`;
		if (ctx.hasUI) ctx.ui.notify(text, "warning");
		else process.stderr.write(`${text}\n`);
	};
	const notifier = new PeerNotifier({
		me: () => me,
		view: () => boardView(backlog.store, db(), reservations),
		overlapWake: () => api.settings.get().subagents?.peerOverlapWake ?? SETTINGS_DEFAULTS.subagents.peerOverlapWake,
		acted: (ref) => wakes?.acted(ref) ?? false,
		wake: (wake) => {
			const sent = wakes?.send(wake);
			if (sent) sent.catch(failed);
		},
		now: Date.now,
	});
	const bus = new BacklogBus({
		head: () => backlogQueries.cursor(db(), backlog.store.repo),
		after: (cursor, limit) => backlogQueries.auditAfter(db(), backlog.store.repo, cursor, limit),
		follow: (poke) => follower.subscribe(poke),
		own: (by) => by === me.session || by === me.agent,
		failed,
	});
	const stop = bus.on((event) => {
		if (event.type === "change") {
			api.channels.emit(BACKLOG_CHANGE_CHANNEL, { change: event.change, own: event.own });
			// A line in the transcript and the web: a session entry, so nothing for the model and no turn.
			const text = statusLine(event.change, event.own);
			if (text) api.session.appendEntry(BACKLOG_LINE_TYPE, { text, ref: event.change.ref, change: event.change.kind });
		}
		notifier.handle(event);
	});
	return { fyi: () => notifier.fyi(), stop };
}
