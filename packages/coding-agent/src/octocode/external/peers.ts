import { randomUUID } from "node:crypto";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import type { FeatureContext } from "../../core/features/index.ts";
import { ApiClient } from "../api/client.ts";
import { issueTicket, ownInstance } from "../api/identity.ts";
import { probeInstances } from "../api/probe.ts";
import { CLIENT_MARGIN_MS, PREPARING, SEND_REPLY_MS, WAIT_MS, WAITING_FOR_USER } from "../api/protocol.ts";
import { ticketTarget } from "../api/registry-integrity.ts";
import { TITLE_PREFIX } from "../processes/title.ts";
import { apiDir, describeInstance, type InstanceRecord, listInstances, selectInstance } from "../api/registry.ts";
import { fenceUntrusted } from "../shared/fence.ts";
import { innermostWorktree } from "../worktrees/occupants.ts";
import { ReadWatch } from "./read-watch.ts";
import { canonical, locateRepo } from "../worktrees/repo.ts";

/** The `to` of a worktree session's merge request: the session in the repository's main checkout. */
const COORDINATOR = "coordinator";


/** What sending needs of the session: the same checks an external prompt passes, and a way to tell the model later. */
interface PeerPolicy {
	authorize(
		target: { name: string; cwd: string },
		text: string,
		ctx: FeatureContext,
		signal?: AbortSignal,
	): Promise<void>;
	notice(text: string): void;
	/** A notice the model reads at its next step, without starting a turn; `notice` stands in when absent. */
	quiet?(text: string): void;
	/** This session's team name, sent with each message as the sender's claim. */
	ownName?(): string | undefined;
	/** The live members of this session's team and the process each runs, so a team name addresses that process. */
	members?(): ReadonlyArray<{ id: string; pid: number }>;
}

/** A refusal before anything reached the other session. */
const notSent = (message: string): Error => Object.assign(new Error(message), { execution: "not-sent" });

/** The running instance `to` names; none or several is a refusal before anything was sent. */
function pick(instances: readonly InstanceRecord[], to: string): InstanceRecord {
	try {
		return selectInstance(instances, to);
	} catch (error) {
		throw Object.assign(new Error(errorMessage(error), { cause: error }), { execution: "not-sent" });
	}
}

/**
 * What a failed `message.send` tells the sender. `execution: "not-sent"` (with the client's `reason` when it has one):
 * nothing arrived, so sending again cannot duplicate it, and the text says when to. `execution: "unknown"`: the call
 * failed after the request may have been read, so the message may have arrived.
 */
function sendFailure(name: string, error: unknown): Error {
	const data = isRecord(error) && isRecord(error.data) ? error.data : {};
	const tags = isRecord(error) ? error : {};
	const said = errorMessage(error);
	if ((data.execution ?? tags.execution) !== "not-sent")
		return Object.assign(
			new Error(`${name} did not take this message: ${said} It may have arrived; check before sending it again.`, {
				cause: error,
			}),
			{ execution: "unknown" },
		);
	const reason = data.reason ?? tags.reason;
	const retryAfterMs = typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined;
	const when =
		reason === "overloaded"
			? ` ${name} has too many connections open; send it again in a few seconds.`
			: reason === "unreachable"
				? ` ${name} is not running or does not answer on its socket; check that it still runs before sending again.`
				: "";
	const nothing = /nothing was sent/i.test(said) ? "" : " Nothing was sent.";
	return Object.assign(new Error(`${name} did not take this message: ${said}${nothing}${when}`, { cause: error }), {
		execution: "not-sent",
		...(typeof reason === "string" ? { reason } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	});
}

/** The running instances of this repository's main checkout, and whether the session at `cwd` sits in a linked worktree. */
async function placeInRepository(
	cwd: string,
	instances: readonly InstanceRecord[],
): Promise<{ main: string; linked: boolean; coordinators: InstanceRecord[] }> {
	const repo = await locateRepo(cwd);
	const roots = repo.entries.filter((entry) => !entry.prunable).map((entry) => entry.path);
	const inMain = (dir: string) => {
		const root = innermostWorktree(roots, dir);
		return root !== undefined && canonical(root) === repo.main;
	};
	return {
		main: repo.main,
		linked: !inMain(cwd),
		coordinators: instances.filter((instance) => inMain(instance.cwd)),
	};
}

/**
 * Reaches another running Octocode by the name `/processes` and `coordinate list` show, over its local session API: the
 * model's `agent` type `message` to a name, so it needs no shell for this. A send does not wait for the receiver's run:
 * an answer is a message back from that name, as with team mail, so two sessions cannot end up waiting on each other.
 * Only a top-level session gets this: a restricted child must not be able to ask an unrestricted session to act.
 */
export class Peers {
	private lifetime = new AbortController();
	/** Keys of sends that got no answer, by target and text. */
	private readonly keys = new Map<string, string>();

	private readonly policy: PeerPolicy;
	private readonly env: NodeJS.ProcessEnv;
	/** Messages other sessions queued and have not read yet. */
	private readonly unread: ReadWatch;
	constructor(policy: PeerPolicy, env: NodeJS.ProcessEnv = process.env) {
		this.policy = policy;
		this.env = env;
		this.unread = new ReadWatch((text) => (policy.quiet ? policy.quiet(text) : policy.notice(text)));
	}

	private instances(): InstanceRecord[] {
		return listInstances(apiDir(this.env));
	}

	/** The live team member `to` names that runs another process; none when `to` is not a team name. */
	private member(to: string): { id: string; pid: number } | undefined {
		return this.policy.members?.().find((member) => member.id === to && member.pid !== process.pid);
	}

	/** The instance a team name's process runs; a name with no session API, or with several records, is a refusal saying what to do. */
	private byTeamName(member: { id: string; pid: number }, instances: readonly InstanceRecord[]): InstanceRecord {
		const found = instances.filter((entry) => entry.pid === member.pid);
		if (found.length === 1) return found[0];
		if (found.length === 0)
			throw notSent(
				`${member.id} is a live team member (pid ${member.pid}) whose session API is off, so it cannot be reached from here. Nothing was sent; ask the user to turn /api on there.`,
			);
		throw notSent(
			`Several instances run as ${member.id} (pid ${member.pid}): ${found.map(describeInstance).join("; ")}. Nothing was sent; use an instance id.`,
		);
	}

	/** Whether `to` names another session rather than a teammate. */
	addresses(to: string): boolean {
		return (
			to === COORDINATOR ||
			this.member(to) !== undefined ||
			// A process name, even a mistyped or stale one, is told what is running instead of being read as a teammate.
			to.startsWith(`${TITLE_PREFIX}-`) ||
			this.instances().some((entry) => entry.name === to || entry.id === to || entry.session === to)
		);
	}

	/** The other sessions on this machine: name, busy state, folder, and which one is this repository's coordinator. */
	async list(cwd: string): Promise<string> {
		const probed = await probeInstances(this.instances());
		const own = probed.find(({ instance }) => instance.pid === process.pid)?.instance;
		const you = own ? `You are ${own.name ?? own.id}. ` : "";
		const others = probed.filter(({ instance }) => instance.pid !== process.pid);
		if (others.length === 0) return `${you}No other Octocode session is running.`;
		const coordinators = await placeInRepository(
			cwd,
			others.map(({ instance }) => instance),
		).then(
			({ coordinators: found }) => found,
			(): InstanceRecord[] => [],
		);
		return visibleControls(
			[
				...(own ? [`You are ${own.name ?? own.id}.`] : []),
				"Other Octocode sessions, reached by `agent` type `message` to the name:",
				...others.map(
					({ instance, state }) =>
						`${instance.name ?? instance.id} · ${state} · ${instance.cwd}${coordinators.includes(instance) ? ` · ${COORDINATOR} of this repository` : ""}`,
				),
			].join("\n"),
		);
	}

	/** The one session in the main checkout; no such session, or several, is a refusal saying what to do. */
	private async coordinator(cwd: string, instances: readonly InstanceRecord[]): Promise<InstanceRecord> {
		const others = instances.filter((instance) => instance.pid !== process.pid);
		const { main, linked, coordinators } = await placeInRepository(cwd, others).catch((error: unknown) => {
			throw notSent(`A ${COORDINATOR} needs a git repository: ${errorMessage(error)} Nothing was sent.`);
		});
		if (!linked)
			throw notSent(
				`This session is in the main checkout, so it is the ${COORDINATOR}. Nothing was sent; merge with \`agent\` type \`coordinate\`, action \`merge\`.`,
			);
		const live = (await probeInstances(coordinators)).map(({ instance }) => instance);
		if (live.length === 1) return live[0];
		if (live.length === 0)
			throw notSent(
				`No Octocode session runs in the main checkout ${main}, so nobody can take this. Nothing was sent. Tell the user; leave this worktree and its branch as they are. A session started there, with its API on, can take the request.`,
			);
		throw notSent(
			`Several Octocode sessions run in the main checkout ${main}: ${live.map(describeInstance).join("; ")}. Nothing was sent. Ask the user which one owns this merge, then send to that name; leave this worktree as it is.`,
		);
	}

	/** Sends `text` to the session `to` names; the receipt, or a refusal saying what happened. */
	async send(
		to: string,
		text: string,
		options: { replyRequired?: boolean },
		ctx: FeatureContext,
		signal?: AbortSignal,
	): Promise<{ text: string; details: Record<string, unknown> }> {
		const instances = this.instances();
		// A live team member's name comes first: it is that name's own process; any other name is a process name or id.
		const member = to === COORDINATOR ? undefined : this.member(to);
		const chosen =
			to === COORDINATOR
				? await this.coordinator(ctx.cwd, instances)
				: member
					? this.byTeamName(member, instances)
					: pick(instances, to);
		const name = chosen.name ?? chosen.id;
		if (chosen.pid === process.pid) throw notSent(`${name} is this session; name another.`);
		// The ticket below lets the receiver confirm this call: only the record in its target's own file, repeated by no other, gets one.
		let target: InstanceRecord;
		try {
			target = ticketTarget(apiDir(this.env), chosen);
		} catch (error) {
			throw notSent(errorMessage(error));
		}
		await this.policy.authorize({ name, cwd: target.cwd }, text, ctx, signal);
		// This session's own API record: a record another process wrote with this pid does not change what it claims.
		const own = ownInstance();
		// The receiver calls this process back with it (`identity.confirm`) to check the claim is this process's own.
		const ticket = issueTicket(target.id, target.socket ?? target.http?.url);
		const memo = target.id;
		const params = {
			text,
			// The same name the reader answers to: the sender's own process name.
			from: own?.name ?? process.title,
			caller: {
				...(this.policy.ownName?.() ? { team: this.policy.ownName?.() } : {}),
				pid: process.pid,
				cwd: own?.cwd ?? ctx.cwd,
				...(own ? { name: own.name, instanceId: own.id, ticket: ticket.ticket } : {}),
			},
			// The receiver's user may take a while to decide: this bounds that wait, not the receiver's work.
			timeoutMs: WAIT_MS.max,
			// The sender may give up before the receiver does: the key lets a retry find the first attempt's outcome.
			key: this.keyFor(memo, text),
			...(options.replyRequired ? { replyRequired: true } : {}),
		};
		const client = new ApiClient(target);
		let receipt: unknown;
		try {
			receipt = await client.call("message.send", params, {
				timeoutMs: SEND_REPLY_MS,
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			ticket.release();
			throw sendFailure(name, error);
		}
		// The receiver answered: the same text sent again is a new message, not a retry.
		this.keys.delete(`${memo}\0${text}`);
		const queued = isRecord(receipt) ? receipt.queued : undefined;
		// A queued message lives only in the receiver's memory until its model reads it: watch for the receiver exiting first.
		if (queued === "steer" || queued === "followUp") this.unread.track({ name, text, target });
		// A follow-up repeats the same params (and ticket) until the receiver's user decides.
		if ((queued === WAITING_FOR_USER || queued === PREPARING) && isRecord(receipt))
			void this.follow(client, name, { ...params, key: receipt.key }).finally(ticket.release);
		else ticket.release();
		const replyPath = own ? "" : " This session's API is off, so it cannot be answered; /api on turns it on.";
		const fate =
			queued === PREPARING
				? `${name} has the message and is still preparing it. You are told if it cannot take it; do not send it again.`
				: queued === WAITING_FOR_USER
					? `Waiting for ${name}'s user to allow this message. You are told if it is refused; do not send it again.`
					: queued === "turn"
						? `Sent to ${name}, which starts a turn on it.`
						: `Sent to ${name}, which reads it at its next step.`;
		return {
			text: `${fate} An answer arrives as a message from ${name}.${replyPath}`,
			details: { to: [name], queued },
		};
	}

	/** The key of a send of `text` to `target`: a repeat after an unanswered send reuses it, so a retry after a lost answer is not delivered twice. */
	private keyFor(target: string, text: string): string {
		const id = `${target}\0${text}`;
		let key = this.keys.get(id);
		if (!key) {
			key = randomUUID();
			if (this.keys.size >= 64) this.keys.delete(this.keys.keys().next().value!);
			this.keys.set(id, key);
		}
		return key;
	}

	/** The outcome of a send its receiver's user is deciding: the same key waits for it. Only a refusal needs telling. */
	private async follow(client: ApiClient, name: string, params: Record<string, unknown>): Promise<void> {
		const { signal } = this.lifetime;
		try {
			await client.call("message.send", params, { timeoutMs: WAIT_MS.max + CLIENT_MARGIN_MS.max, signal });
		} catch (error) {
			if (signal.aborted) return;
			this.policy.notice(
				fenceUntrusted(`${name} did not take your message`, errorMessage(error), {
					footer: "Tell the user if it matters to your work; do not send it again unless they ask.",
				}),
			);
		}
	}

	/** The session ended: nobody is left to tell. */
	reset(): void {
		this.unread.stop();
		this.lifetime.abort();
		this.lifetime = new AbortController();
	}
}
