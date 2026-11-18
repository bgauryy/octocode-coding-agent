import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { attend } from "../../monitor/attention/attend.ts";
import { childIdleText, IdleWatch, idleAgentMs, selfIdleText } from "../../monitor/attention/idle-agent.ts";
import { monitorLedgerOf } from "../../monitor/ledger.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../shared/messages.ts";
import { sessionPhaseOf } from "../../shared/session-phase.ts";
import { STATUS } from "../../shared/status.ts";
import { isStaleSessionError } from "../../shared/util.ts";
import type { MailDetails } from "../model.ts";
import type { WakePace } from "../wake-pace.ts";
import type { WaitingApprovals } from "./approvals.ts";

/** The custom message type of a main session's note to itself about its own silence. */
export const SELF_IDLE_TYPE = "octocode-idle-agent";

/** What the idle-agent rule reads of the team (`TeamState`): the current values each time. */
export interface IdleHost {
	me(): Member | undefined;
	parentId(): string | undefined;
	ctx(): FeatureContext | undefined;
	/** The running children this agent started, by id. */
	children(): string[];
	/** The team's rows, read only when a child is due. */
	members(): Member[];
	readonly approvals: Pick<WaitingApprovals, "lastOutput" | "waitsOnUser">;
	readonly wakePace: Pick<WakePace, "allows" | "record">;
}

const minutesOf = (ms: number) => Math.round(ms / 60_000);

/**
 * The idle-agent rule for the agents this one is responsible for: its running children (their last progress is what
 * this process saw of their model and tool events) and, in a main session, itself. Checked from the team ticker once a
 * minute (`IDLE_CHECK_MS`); each silence is told once, and new progress re-arms it.
 */
export class IdleAgents {
	private readonly watch = new IdleWatch();
	/** This session's last model or tool event (`registerTeamEvents`). */
	private progressAt: number | undefined;
	private marked = false;
	private readonly api: FeatureSetup;
	private readonly host: IdleHost;

	constructor(api: FeatureSetup, host: IdleHost) {
		this.api = api;
		this.host = host;
	}

	/** This session made progress: a told silence is over, so its footer mark goes at once. */
	progressed(at = Date.now()): void {
		this.progressAt = at;
		if (this.marked) this.mark(undefined);
	}

	check(now = Date.now()): void {
		if (!this.watch.due(now)) return;
		try {
			this.checkAgents(now);
		} catch (error) {
			// The ticker can beat once more after /new, /reload, fork or switch; the replaced session's api is gone.
			if (!isStaleSessionError(error)) throw error;
		}
	}

	private checkAgents(now: number): void {
		const thresholdMs = idleAgentMs(this.api.settings.get?.());
		const me = this.host.me();
		// Nobody is above a main session, so it is told about itself; a subagent's parent watches it.
		const self = me && !this.host.parentId() && me.status === "working" ? me.id : undefined;
		const agents = this.host.children().map((id) => ({ id, progressAt: this.host.approvals.lastOutput(id) }));
		if (self) agents.push({ id: self, progressAt: this.progressAt });
		const idle = this.watch.idle(agents, thresholdMs, now);
		const children = idle.filter((id) => id !== self);
		const members = children.length > 0 ? new Map(this.host.members().map((member) => [member.id, member])) : undefined;
		for (const id of idle) {
			const told = id === self ? this.tellSelf(id, thresholdMs, now) : this.tellParent(id, members!, thresholdMs, now);
			if (told) this.watch.told(id);
		}
		if (!this.watch.anyTold()) {
			monitorLedgerOf(this.api).trip("idle-agent", false);
			if (this.marked) this.mark(undefined);
		}
	}

	reset(): void {
		this.watch.reset();
		this.progressAt = undefined;
		if (this.marked) this.mark(undefined);
	}

	/** A main session waiting on the user's answer, or on its own agents and jobs, is not idle. */
	private selfWaits(): boolean {
		const { dialog, work } = sessionPhaseOf(this.api).factsNow();
		return dialog !== undefined || work.agents + work.queued + work.bash + work.external > 0;
	}

	private tellSelf(id: string, thresholdMs: number, now: number): boolean {
		if (this.selfWaits() || this.progressAt === undefined) return false;
		const minutes = minutesOf(now - this.progressAt);
		this.send(
			{ rule: "idle-agent", value: minutes, threshold: minutesOf(thresholdMs), subject: id, at: now },
			{ customType: SELF_IDLE_TYPE, content: selfIdleText(minutes) },
			false,
		);
		this.mark(`no progress ${minutes}m`);
		return true;
	}

	/**
	 * Tells this agent about child `id`, waking it within its wake pace. A child that stopped working, waits on the user's
	 * answer or on its own working children is excused (its declared long tools and jobs already count as progress).
	 */
	private tellParent(id: string, members: ReadonlyMap<string, Member>, thresholdMs: number, now: number): boolean {
		const member = members.get(id);
		const waits =
			!member ||
			member.status !== "working" ||
			member.waiting !== undefined ||
			this.host.approvals.waitsOnUser(id) ||
			[...members.values()].some((other) => other.parentId === id && other.status === "working");
		const progressAt = this.host.approvals.lastOutput(id);
		if (waits || progressAt === undefined) return false;
		const minutes = minutesOf(now - progressAt);
		const text = childIdleText(id, minutes, member.activity);
		const details: MailDetails = { messages: [{ from: "team", text, at: now }] };
		const wake = this.host.wakePace.allows();
		this.send(
			{ rule: "idle-agent", value: minutes, threshold: minutesOf(thresholdMs), subject: id, at: now },
			{ customType: INTERNAL_MESSAGE_TYPE, content: text, details, display: true },
			wake,
		);
		if (wake) this.host.wakePace.record();
		return true;
	}

	private send(
		attention: Parameters<typeof attend>[1],
		message: { customType: string; content: string; details?: unknown; display?: boolean },
		wake: boolean,
	): void {
		void attend(
			this.api,
			attention,
			message,
			wake ? { how: "wake", deliverAs: "steer" } : { how: "note", deliverAs: "steer" },
		).catch((error: unknown) => {
			const ctx = this.host.ctx();
			if (ctx?.hasUI) ctx.ui.notify(`An idle-agent notice failed: ${errorMessage(error)}`, "warning");
		});
	}

	/** The footer mark of this session's own silence; undefined clears it. */
	private mark(text: string | undefined): void {
		this.marked = text !== undefined;
		const ctx = this.host.ctx();
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS.idleAgent, text, "warning");
		} catch (error) {
			if (!isStaleSessionError(error)) throw error;
		}
	}
}
