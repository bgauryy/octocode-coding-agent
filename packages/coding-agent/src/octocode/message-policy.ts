import type { ExtensionContext } from "../core/features/index.ts";
import type { ExternalAdmission } from "./api/bridge/contracts.ts";
import type { ExternalParams } from "./external/protocol.ts";
import type { registerHooks } from "./hooks/register.ts";
import type { Permission } from "./permission/ask.ts";
import { admitExternalMessage } from "./permission/external-message.ts";
import type { createProvenance } from "./permission/provenance.ts";
import type { MessageEnvelope } from "./shared/messages.ts";
import type { Team } from "./team/session.ts";
import { mergeWorktreeBranch } from "./worktrees/merge.ts";

/**
 * The checks a message between agents passes, in one place: sending to a teammate, to an outside agent or to another
 * process, and letting one in. Hooks run first, then the permission layer; the plan constraint blocks what leaves this
 * session and asks about what arrives.
 */
export function messagePolicy({
	hooks,
	permission,
	planning,
	provenance,
	team,
}: {
	hooks: ReturnType<typeof registerHooks>;
	permission: Permission;
	planning: { blocked(): boolean };
	provenance: ReturnType<typeof createProvenance>;
	team: Pick<Team, "reservation">;
}) {
	const messageHooks = async (message: MessageEnvelope, ctx: ExtensionContext, signal?: AbortSignal) => {
		const verdict = await hooks.messageSend(message, signal ? { ...ctx, signal } : ctx);
		if (verdict?.block) {
			permission.refused([`${message.from} → ${message.to}`], verdict.block, "message");
			throw new Error(verdict.block);
		}
		if (verdict?.ask) {
			const checked = await permission.check(ctx, {
				title: "Send this message?",
				what: [`${message.from} → ${message.to}`, message.text],
				reasons: ["hook.ask"],
				reason: verdict.ask,
				...(signal ? { signal } : {}),
			});
			if (!checked.allowed) throw new Error(checked.message);
		}
		signal?.throwIfAborted();
	};
	const notWhilePlanning = (what: string) => {
		if (planning.blocked()) throw new Error(`${what} blocked during planning.`);
	};
	/** A send that starts work elsewhere, by a connection or by a name: a provenance hit and the mode decide, as for a subagent. */
	const authorizeSend = async (
		hit: ReturnType<typeof provenance.sent>,
		request: { title: string; what: string[]; cwd: string; effect: string; grant?: { key: string; label: string } },
		ctx: ExtensionContext,
		signal?: AbortSignal,
	) => {
		const checked = await permission.check(ctx, {
			...(hit ? { reasons: ["provenance" as const], reason: hit.why } : {}),
			action: "agent.spawn",
			...request,
			...(signal ? { signal } : {}),
		});
		if (!checked.allowed) throw new Error(checked.message);
	};
	return {
		/** An outbound message to a teammate or an outside agent. */
		beforeMessage: async (message: MessageEnvelope, ctx: ExtensionContext, signal?: AbortSignal) => {
			notWhilePlanning("Agent message dispatch is");
			await messageHooks(message, ctx, signal);
		},
		/** An inbound message's hooks; whether it may arrive at all is `admit`. */
		inboundHooks: messageHooks,
		admit: (claim: ExternalAdmission, ctx: ExtensionContext, signal?: AbortSignal, onAsk?: () => void) =>
			admitExternalMessage(permission, ctx, claim, {
				self: claim.self,
				planning: planning.blocked(),
				...(claim.ceiling ? { ceiling: claim.ceiling } : {}),
				...(onAsk ? { onAsk } : {}),
				...(signal ? { signal } : {}),
			}),
		authorizeExternal: async (input: ExternalParams, ctx: ExtensionContext, signal: AbortSignal) => {
			notWhilePlanning("External agent dispatch is");
			await authorizeSend(
				input.action === "prompt" ? provenance.sent(input, ctx) : undefined,
				{
					title: input.action === "connect" ? "Connect this external agent?" : "Send this external prompt?",
					what: [JSON.stringify(input)],
					cwd: input.cwd ?? ctx.cwd,
					effect: "The external agent uses its own credentials, tools and permission policy.",
				},
				ctx,
				signal,
			);
		},
		/** `agent` type `message` to another process: the send hooks, then the same check as an external prompt, once per process when granted. */
		authorizePeer: async (
			target: { name: string; cwd: string },
			text: string,
			ctx: ExtensionContext,
			signal?: AbortSignal,
		) => {
			notWhilePlanning("Agent message dispatch is");
			await messageHooks(
				{ channel: "external", direction: "outbound", from: process.title, to: target.name, text },
				ctx,
				signal,
			);
			await authorizeSend(
				provenance.sent({ text }, ctx),
				{
					title: "Send this message to another Octocode process?",
					what: [`to ${target.name}, working in ${target.cwd}`, text],
					cwd: target.cwd,
					effect: "The other session uses its own credentials, tools and permission mode.",
					grant: { key: `message:${target.name}`, label: `messages to ${target.name}` },
				},
				ctx,
				signal,
			);
		},
		/** The model's `coordinate merge`: the `worktree.merge` class asks in every mode, because a message never approves a merge. */
		mergeBranch: (branch: string, ctx: ExtensionContext, signal?: AbortSignal) =>
			mergeWorktreeBranch(ctx.cwd, branch, {
				reservation: (file, shown) => team.reservation(file, shown),
				approve: async (what) => {
					const verdict = await permission.check(ctx, {
						action: "worktree.merge",
						title: "Merge this worktree's branch into the main checkout?",
						what,
						purpose: "",
						cwd: ctx.cwd,
						...(signal ? { signal } : {}),
					});
					return verdict.allowed ? undefined : verdict.message;
				},
			}),
		/** `/worktree merge <branch>`: consent by typing, so it runs, and the audit still says so. */
		typedMerge: (branch: string, ctx: ExtensionContext) => {
			permission.typed(`/worktree merge ${branch}`, ctx.cwd);
			return mergeWorktreeBranch(ctx.cwd, branch, { reservation: (file, shown) => team.reservation(file, shown) });
		},
	};
}
