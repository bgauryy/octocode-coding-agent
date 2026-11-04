import type { Component } from "@octocodeai/octocode-tui";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { ExtensionContext } from "../../core/features/index.ts";
import type { StatusTone } from "../../core/footer-data-provider.ts";
import { plural } from "../shared/render/text.ts";
import { STATUS } from "../shared/status.ts";
import { needsYou } from "./panel-attention.ts";
import { FINISHED_MS, safe } from "./panel-compact.ts";
import { type AgentEnd, FinishedTracker } from "./panel-finished.ts";
import { widgetLines } from "./panel-layout.ts";
import { PanelMotion } from "./panel-motion.ts";
import { descendants, liveMembers, roster } from "./panel-roster.ts";
import { panelState } from "./panel-state.ts";
import { trafficRow } from "./panel-traffic.ts";
import type { Team } from "./session.ts";

export { trafficRow, widgetLines };

/** The panel widget's key. The widget is static text only: its rows are pure in (members, width, now), so repainting never moves the transcript. */
const WIDGET_KEY = "octocode-agents";

/**
 * Keeps the below-editor widget in step with the team while there is something to show. The footer segment names this
 * session once it joined the team (peers and messages address it by that name), or says when the team is off; the
 * widget already counts the agents. It reads nothing itself: the team session's ticker refreshes a cached view and calls back once a second.
 */
export class AgentsView {
	private unwatch: (() => void) | undefined;
	private members: Member[] = [];
	private traffic: Traffic[] = [];
	private readonly finished = new FinishedTracker();
	private shown = false;
	/** Last footer text sent: an unchanged one is not sent again on every tick. */
	private status: string | undefined;
	private render: (() => void) | undefined;
	/** Repaints on the animation clock while an agent works or just finished, and not otherwise. */
	private readonly motion = new PanelMotion(
		(now) =>
			roster(
				this.members,
				this.team.id,
				now,
				this.finished.finished,
				needsYou(this.members, this.traffic, this.team.id),
			).tree.map((entry) => ({
				...panelState(entry, now),
				...(entry.doneAt === undefined ? {} : { since: entry.doneAt }),
			})),
		() => this.render?.(),
	);
	/** Background subagents this session runs, and the footer text last sent for them. */
	private background = 0;
	private backgroundStatus: string | undefined;
	private ctx: ExtensionContext | undefined;

	private readonly team: Team;
	constructor(team: Team) {
		this.team = team;
	}

	start(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		this.stop(ctx);
		this.ctx = ctx;
		this.showBackground(ctx);
		// A terminal widget: RPC clients ignore component factories, so the 1 s ticker would feed nothing there.
		if (ctx.mode !== "tui") return;
		this.unwatch = this.team.watch(() => this.paint(ctx));
	}

	/** The host learned how subagent `id`'s run ended: its row shows the outcome and headline instead of a neutral `left`. */
	noteEnd(id: string, end: AgentEnd): void {
		this.finished.noteEnd(id, end, Date.now());
		this.render?.();
		this.motion.sync();
	}

	/** How many background subagents run now: counted in the footer while the panel does not show them. */
	setBackground(count: number): void {
		this.background = count;
		if (this.ctx) this.showBackground(this.ctx);
	}

	private showBackground(ctx: ExtensionContext): void {
		const text = this.background > 0 && !this.shown ? plural(this.background, "background agent") : undefined;
		if (text === this.backgroundStatus) return;
		this.backgroundStatus = text;
		try {
			ctx.ui.setStatus(STATUS.subagents, text, "accent");
		} catch {
			// The session was replaced.
		}
	}

	stop(ctx?: ExtensionContext): void {
		this.unwatch?.();
		this.unwatch = undefined;
		this.motion.dispose();
		this.ctx = undefined;
		if (ctx && this.backgroundStatus !== undefined) {
			this.backgroundStatus = undefined;
			try {
				ctx.ui.setStatus(STATUS.subagents, undefined);
			} catch {
				// The session was replaced.
			}
		}
		if (ctx && (this.shown || this.status !== undefined)) this.clear(ctx);
		this.render = undefined;
		this.members = [];
		this.traffic = [];
		this.finished.clear();
	}

	private setStatus(ctx: ExtensionContext, text: string | undefined, tone?: StatusTone): void {
		const shown = text === undefined ? undefined : `${tone ?? ""}\0${text}`;
		if (shown === this.status) return;
		this.status = shown;
		ctx.ui.setStatus(STATUS.team, text, tone);
	}

	private clear(ctx: ExtensionContext): void {
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

	private paint(ctx: ExtensionContext): void {
		try {
			const { members, traffic, error, retrying } = this.team.view;
			this.members = members;
			this.traffic = traffic;
			const self = this.team.id;
			// The same liveness filter as widgetLines: a widget with no rows is never mounted.
			const now = Date.now();
			const live = descendants(liveMembers(this.members, now), self);
			if (!error) this.finished.update(self, this.members, live, now);
			const visible = live.length > 0 || this.finished.finished.some((entry) => now - entry.at <= FINISHED_MS);
			if (error) {
				// A foreign database turns the team off for this session; a locked one is retried on the next tick.
				// Either way the widget keeps its state, and mounts once a read succeeds.
				this.setStatus(
					ctx,
					retrying ? `team retrying: ${safe(error, 80)}` : `team off: ${safe(error, 80)}`,
					retrying ? "warning" : "error",
				);
				this.showBackground(ctx);
				return;
			}
			const named = self ? `main: ${safe(self, 64)}` : undefined;
			if (!visible) {
				if (this.shown) this.clear(ctx);
				this.setStatus(ctx, named, "muted");
				this.showBackground(ctx);
				return;
			}
			this.setStatus(ctx, named, "muted");
			if (!this.shown) {
				this.shown = true;
				ctx.ui.setWidget(
					WIDGET_KEY,
					(tui, theme): Component => {
						this.render = () => tui.requestRender();
						return {
							render: (width: number) =>
								widgetLines(
									this.members,
									this.team.id,
									Date.now(),
									theme,
									width,
									this.traffic,
									tui.terminal?.rows,
									this.finished.finished,
								),
							invalidate: () => undefined,
						};
					},
					{ placement: "belowEditor" },
				);
			}
			this.render?.();
			this.motion.sync();
			this.showBackground(ctx);
		} catch {
			// The session was replaced while painting.
		}
	}
}
