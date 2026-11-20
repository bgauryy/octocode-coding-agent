import type { Component, TuiMouseEvent } from "@octocodeai/octocode-tui";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { FeatureContext } from "../../core/features/index.ts";
import type { StatusTone } from "../../core/footer-data-provider.ts";
import { notify } from "../shared/commands.ts";
import { type QueuedWork, RunningWork, type WorkRow, workCounts } from "../shared/running-work.ts";
import { ENTITY } from "../shared/entity.ts";
import { STATUS } from "../shared/status.ts";
import { publishLiveAgents } from "../shared/team-spend.ts";
import { needsYou } from "./panel/attention.ts";
import { FINISHED_MS, safe } from "./panel/compact.ts";
import { FinishedTracker } from "./panel/finished.ts";
import { ActivityHold } from "./panel/hold.ts";
import { widgetLines, widgetRows } from "./panel/layout.ts";
import { type Moving, PanelMotion } from "./panel/motion.ts";
import { nextMinuteDelay } from "./panel/work.ts";
import { TeamOutage } from "./panel/outage.ts";
import { descendants, liveMembers, peers, roster } from "./panel/roster.ts";
import { markSince, panelState } from "./panel/state.ts";
import { withEndpoints } from "./endpoint.ts";
import { trafficRow } from "./panel/traffic.ts";
import type { Team } from "./session.ts";

export { trafficRow, widgetLines };

/** The panel widget's key. The widget is static text only: its rows are pure in (members, width, now), so repainting never moves the transcript. */
const WIDGET_KEY = "octocode-agents";

/**
 * Keeps the below-editor widget in step with the team while there is something to show. The footer segment names this
 * session once it joined the team (peers and messages address it by that name), or says when the team is off; the
 * widget already counts the agents. It reads nothing itself: the team session's ticker refreshes a cached view and calls back once a second.
 * The same widget lists the other running work (bash jobs, timers, background subagents the team does not list) from the
 * session's `RunningWork`, and the footer's `running` segment counts it all by type. Those rows repaint when their owner
 * publishes a change. Every work row has a spinner and counts in seconds on the motion clock; in reduced motion, where no mark moves, the clocks repaint once a minute (whole minutes) and nothing repaints when no work has a clock.
 */
export class AgentsView {
	private unwatch: (() => void) | undefined;
	private members: Member[] = [];
	private traffic: Traffic[] = [];
	private readonly finished: FinishedTracker;
	/** The activity lines as drawn: a thought held briefly, a running bash command kept until the next tool. */
	private readonly hold = new ActivityHold();
	/** Says a team database failure and its recovery in the messages list; the footer keeps only the short state. */
	private readonly outage = new TeamOutage();
	private shown = false;
	/** When each agent was first seen waiting on a dialog: its waiting mark breathes from then, a few seconds only. */
	private readonly waitSeen = new Map<string, number>();
	/** Agents whose detail line is open (a left click on any of their rows toggles it). */
	private readonly expanded = new Set<string>();
	/** The agent each line drawn last belongs to, for a click. */
	private owners: Array<string | undefined> = [];
	/** Last footer text sent: an unchanged one is not sent again on every tick. */
	private status: string | undefined;
	private render: (() => void) | undefined;
	/** Repaints on the animation clock while an agent works or just finished or any work row runs, and not otherwise. */
	private readonly motion = new PanelMotion(
		(now) => [
			...this.teamMarks(now),
			// Running work moves too: its spinner and second clock show it is alive while the main agent idles.
			...this.workItems()
				.filter((row) => !row.mark)
				.map((): Moving => ({ state: "running" })),
		],
		() => {
			// While a mark moves the panel's own clock runs: it also looks for a child's new row, so lines follow within a fraction of a second.
			this.team.poll();
			this.render?.();
		},
		// With no mark moving, still-running work repaints once a minute, on the oldest row's boundary.
		(now) => nextMinuteDelay(this.workItems(), now),
	);
	/** The marks the team rows draw at `now`: each agent's, and while there are agents, this session's and its peers'. */
	private teamMarks(now: number): Moving[] {
		const { tree } = roster(
			this.members,
			this.team.id,
			now,
			this.finished.finished,
			needsYou(this.members, this.traffic, this.team.id, this.waitSeen, now),
		);
		if (tree.length === 0) return [];
		const self = this.members.filter((member) => member.id === this.team.id);
		return [
			...tree.map((entry): Moving => {
				const since = markSince(entry);
				return { ...panelState(entry, now), ...(since === undefined ? {} : { since }) };
			}),
			...[...self, ...peers(this.members, this.team.id, now)].map((member): Moving =>
				panelState({ member, depth: 0 }, now),
			),
		];
	}

	/** This session's live subagents as of the last team read. */
	private liveIds = new Set<string>();
	/** The footer's typed counts last sent. */
	private runningStatus: string | undefined;
	private unwork: (() => void) | undefined;
	private ctx: FeatureContext | undefined;
	/** True while `paint` runs: the count it publishes must not start a second paint. */
	private painting = false;

	private readonly team: Team;
	private readonly work: RunningWork;
	constructor(team: Team, work: RunningWork = new RunningWork()) {
		this.team = team;
		this.work = work;
		this.finished = new FinishedTracker((id) => team.approvals?.endOf(id));
	}

	start(ctx: FeatureContext): void {
		if (!ctx.hasUI) return;
		this.stop(ctx);
		this.ctx = ctx;
		this.showRunning(ctx);
		this.unwork = this.work.subscribe(() => {
			// The paint in progress publishes the count it just changed and renders once itself.
			if (this.painting) return;
			this.showRunning(ctx);
			// A change of work mounts or repaints the widget now; the team's ticker is not what moves it.
			if (ctx.mode === "tui") this.paint(ctx, true);
		});
		// A terminal widget: RPC clients ignore component factories, so there the ticker only keeps the live agents and the footer count.
		if (ctx.mode !== "tui") {
			this.unwatch = this.team.watch(() => this.track(ctx));
			return;
		}
		this.unwatch = this.team.watch(() => this.paint(ctx));
	}

	/** Without a widget: follows the team's live agents for the footer count. */
	private track(ctx: FeatureContext): void {
		const { members, error } = this.team.view;
		this.members = members;
		this.refreshLive(error);
		this.showRunning(ctx);
	}

	/** This session's live agents: a finished parent still links its running children, as the roster draws them. */
	private refreshLive(error: unknown): Member[] {
		const now = Date.now();
		const self = this.team.id;
		const compute = (): Member[] => {
			const known = new Set(this.members.map((member) => member.id));
			const left = this.finished.finished
				.filter((entry) => now - entry.at <= FINISHED_MS && !known.has(entry.member.id))
				.map((entry) => entry.member);
			// A finished parent only bridges to its running children: it is not live itself.
			const leftIds = new Set(left.map((member) => member.id));
			return liveMembers(
				descendants([...this.members, ...left], self).filter((member) => !leftIds.has(member.id)),
				now,
			);
		};
		let live = compute();
		if (!error) {
			// An agent that just left becomes a finished row first, so its running children stay linked in this very pass.
			this.finished.update(self, this.members, live, now);
			live = compute();
			this.finished.update(self, this.members, live, now);
			// The footer's one total adds what these agents spent until their results reach this session's ledger.
			publishLiveAgents(live);
		}
		this.liveIds = new Set(live.map((member) => member.id));
		return live;
	}

	/** The background subagents this session runs now: one without a team row yet (queued, starting, team off) still shows. */
	setBackground(names: readonly string[]): void {
		// The work store tells its listeners, this view among them, so the footer and the tab title follow one list.
		this.work.setBackground(names);
	}

	/** The children queued behind prerequisites: they show as `queued` and `held` rows and count as `N queued`. */
	/** Rows for children that ended with the previous process of a resumed session (`FinishedTracker.restore`). */
	restoreFinished(ended: Parameters<FinishedTracker["restore"]>[0]): void {
		this.finished.restore(ended, Date.now());
	}

	setQueued(rows: readonly QueuedWork[]): void {
		this.work.setQueued(rows);
	}

	/** Background subagents with no live team row: the rows the work block draws for them. */
	private unlisted(): WorkRow[] {
		// A child that just finished is a team row, not also a work row; one whose heartbeat stalled has no live row and still shows here.
		const gone = new Set(this.finished.finished.map((entry) => entry.member.id));
		const queued = new Map(this.work.queued().map((row) => [row.id, row]));
		return this.work
			.background()
			.filter((name) => !this.liveIds.has(name) && !gone.has(name))
			.map((id): WorkRow => {
				const wait = queued.get(id);
				return wait
					? { kind: "agent", id, title: wait.title, mark: wait.held ? "held" : "queued" }
					: { kind: "agent", id, title: "running in the background" };
			});
	}

	/** Every row of running work outside the team's tree. */
	private workItems(): WorkRow[] {
		return [...this.unlisted(), ...this.work.all()];
	}

	/** The footer's typed counts: live subagents (and unlisted background ones), bash jobs, timers. */
	private showRunning(ctx: FeatureContext, teamShown = false): void {
		const agents = this.liveIds.size + this.unlisted().filter((row) => !row.mark).length;
		// The tab title counts the same agents.
		this.work.setAgents(agents);
		// The panel's root row already counts the agents it lists.
		const text = workCounts(teamShown ? 0 : agents, this.work.all(), this.work.queued().length) || undefined;
		if (text === this.runningStatus) return;
		this.runningStatus = text;
		try {
			ctx.ui.setStatus(STATUS.running, text, "accent");
		} catch {
			// The session was replaced.
		}
	}

	stop(ctx?: FeatureContext): void {
		this.unwatch?.();
		this.unwatch = undefined;
		this.unwork?.();
		this.unwork = undefined;
		this.motion.dispose();
		this.ctx = undefined;
		this.liveIds = new Set();
		publishLiveAgents([]);
		this.work.setAgents(undefined);
		if (ctx && this.runningStatus !== undefined) {
			this.runningStatus = undefined;
			try {
				ctx.ui.setStatus(STATUS.running, undefined);
			} catch {
				// The session was replaced.
			}
		}
		if (ctx && (this.shown || this.status !== undefined)) this.clear(ctx);
		this.render = undefined;
		this.members = [];
		this.traffic = [];
		this.finished.clear();
		this.hold.clear();
		this.expanded.clear();
		this.waitSeen.clear();
		this.owners = [];
		this.outage.reset();
	}

	private setStatus(ctx: FeatureContext, text: string | undefined, tone?: StatusTone): void {
		const shown = text === undefined ? undefined : `${tone ?? ""}\0${text}`;
		if (shown === this.status) return;
		this.status = shown;
		ctx.ui.setStatus(STATUS.team, text, tone);
	}

	private clear(ctx: FeatureContext): void {
		this.shown = false;
		this.motion.dispose();
		this.status = undefined;
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS.team, undefined);
		} catch {
			// The session was replaced.
		}
	}

	/** Mounts the widget when it is not shown; true when this call mounted it. */
	private mount(ctx: FeatureContext): boolean {
		if (this.shown) return false;
		this.shown = true;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme): Component => {
				this.render = () => tui.requestRender();
				return {
					render: (width: number) => {
						const now = Date.now();
						const drawn = widgetRows(
							this.hold.apply(this.members, now),
							this.team.id,
							now,
							theme,
							width,
							this.traffic,
							tui.terminal?.rows,
							this.finished.finished,
							this.workItems(),
							this.motion.precise,
							this.expanded,
							this.waitSeen,
						);
						this.owners = drawn.owners;
						return drawn.lines;
					},
					handleMouse: (event: TuiMouseEvent) => this.click(event),
					invalidate: () => undefined,
				};
			},
			{ placement: "belowEditor" },
		);
		return true;
	}

	/** A left click on an agent's row opens or closes its detail line. */
	private click(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const id = this.owners[event.y];
		if (id === undefined) return undefined;
		if (!this.expanded.delete(id)) this.expanded.add(id);
		this.render?.();
		return { handled: true };
	}

	/** `force`: the work rows changed, so repaint even when the team shows nothing new. */
	private paint(ctx: FeatureContext, force = false): void {
		this.painting = true;
		try {
			const { members, traffic, error, retrying } = this.team.view;
			const said = this.outage.next(error, retrying);
			if (said) notify(ctx.ui, said.text, said.level);
			this.members = members;
			const self = this.team.id;
			const root = members.find((member) => member.id === self)?.checkout;
			// Each message names its recipients with role and marks (live members only: the panel never reads the database).
			this.traffic = traffic.map((message) => withEndpoints(message, { members, ...(root ? { root } : {}) }));
			// The same liveness filter as widgetLines: a widget with no rows is never mounted.
			const now = Date.now();
			const live = this.refreshLive(error);
			const teamVisible = live.length > 0 || this.finished.finished.some((entry) => now - entry.at <= FINISHED_MS);
			const hasWork = this.workItems().length > 0;
			this.showRunning(ctx, teamVisible);
			if (error) {
				// A foreign database turns the team off for this session; a locked one is retried on the next tick.
				// Either way the widget keeps its state, and mounts once a read succeeds. The footer shows the state; the
				// error itself went to the messages list above. Running work that needs no team still shows.
				this.setStatus(ctx, retrying ? "team retrying" : "team off", retrying ? "warning" : "error");
				if (hasWork && this.mount(ctx)) this.render?.();
				return;
			}
			const named = self ? `${ENTITY.main} ${safe(self, 64)}` : undefined;
			if (!teamVisible && !hasWork) {
				if (this.shown) this.clear(ctx);
				this.setStatus(ctx, named, "muted");
				return;
			}
			// The panel's root row names this session; the footer would repeat it.
			this.setStatus(ctx, undefined);
			const mounted = this.mount(ctx);
			// The team's rows repaint with its one-second read; work-only rows repaint when their owner says so.
			this.motion.sync();
			if (teamVisible || force || mounted) this.render?.();
		} catch {
			// The session was replaced while painting.
		} finally {
			this.painting = false;
		}
	}
}
