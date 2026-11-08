import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import type { ExtensionContext } from "../../core/features/index.ts";
import { ApiClient } from "../api/client.ts";
import { issueTicket, ownInstance } from "../api/identity.ts";
import { probeInstances } from "../api/probe.ts";
import { CLIENT_MARGIN_MS, WAIT_MS, WAITING_FOR_USER } from "../api/protocol.ts";
import { ticketTarget } from "../api/registry-integrity.ts";
import { apiDir, describeInstance, type InstanceRecord, listInstances, selectInstance } from "../api/registry.ts";
import { fenceUntrusted } from "../shared/fence.ts";
import { innermostWorktree } from "../worktrees/occupants.ts";
import { canonical, locateRepo } from "../worktrees/repo.ts";

/** The `to` of a worktree session's merge request: the session in the repository's main checkout. */
const COORDINATOR = "coordinator";

/** How a process name looks, so a mistyped or stale one is told what is running instead of being read as a teammate. */
const PROCESS_NAME = /^octocode-[A-Za-z0-9._]+-/;

/** What sending needs of the session: the same checks an external prompt passes, and a way to tell the model later. */
interface PeerPolicy {
	authorize(
		target: { name: string; cwd: string },
		text: string,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<void>;
	notice(text: string): void;
}

/** A refusal before anything reached the other session. */
const notSent = (message: string): Error => Object.assign(new Error(message), { execution: "not-sent" });

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

	private readonly policy: PeerPolicy;
	private readonly env: NodeJS.ProcessEnv;
	constructor(policy: PeerPolicy, env: NodeJS.ProcessEnv = process.env) {
		this.policy = policy;
		this.env = env;
	}

	private instances(): InstanceRecord[] {
		return listInstances(apiDir(this.env));
	}

	/** Whether `to` names another session rather than a teammate. */
	addresses(to: string): boolean {
		return (
			to === COORDINATOR ||
			PROCESS_NAME.test(to) ||
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
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<{ text: string; details: Record<string, unknown> }> {
		const instances = this.instances();
		const chosen = to === COORDINATOR ? await this.coordinator(ctx.cwd, instances) : selectInstance(instances, to);
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
		const params = {
			text,
			// The same name the reader answers to: the sender's own process name.
			from: own?.name ?? process.title,
			caller: {
				pid: process.pid,
				cwd: own?.cwd ?? ctx.cwd,
				...(own ? { name: own.name, instanceId: own.id, ticket: ticket.ticket } : {}),
			},
			// The receiver's user may take a while to decide: this bounds that wait, not the receiver's work.
			timeoutMs: WAIT_MS.max,
			...(options.replyRequired ? { replyRequired: true } : {}),
		};
		const client = new ApiClient(target);
		let receipt: unknown;
		try {
			receipt = await client.call("message.send", params, {
				timeoutMs: WAIT_MS.default + CLIENT_MARGIN_MS.default,
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			ticket.release();
			const execution = isRecord(error) && isRecord(error.data) ? error.data.execution : undefined;
			const notDelivered = execution === "not-sent" || (isRecord(error) && error.execution === "not-sent");
			throw new Error(
				`${name} did not take this message: ${errorMessage(error)}${notDelivered ? " Nothing was sent." : " It may have arrived; check before sending it again."}`,
				{ cause: error },
			);
		}
		const queued = isRecord(receipt) ? receipt.queued : undefined;
		// A follow-up repeats the same params (and ticket) until the receiver's user decides.
		if (queued === WAITING_FOR_USER && isRecord(receipt))
			void this.follow(client, name, { ...params, key: receipt.key }).finally(ticket.release);
		else ticket.release();
		const replyPath = own ? "" : " This session's API is off, so it cannot be answered; /api on turns it on.";
		const fate =
			queued === WAITING_FOR_USER
				? `Waiting for ${name}'s user to allow this message. You are told if it is refused; do not send it again.`
				: queued === "turn"
					? `Sent to ${name}, which starts a turn on it.`
					: `Sent to ${name}, which reads it at its next step.`;
		return {
			text: `${fate} An answer arrives as a message from ${name}.${replyPath}`,
			details: { to: [name], queued },
		};
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
		this.lifetime.abort();
		this.lifetime = new AbortController();
	}
}
