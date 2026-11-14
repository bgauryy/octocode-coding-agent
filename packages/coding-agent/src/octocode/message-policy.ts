import type { ExtensionAPI, ExtensionContext } from "../core/features/index.ts";
import { renderInstruction } from "../core/prompt-template.ts";
import type { ExternalAdmission } from "./api/bridge/contracts.ts";
import type { ExternalParams } from "./external/protocol.ts";
import type { registerHooks } from "./hooks/register.ts";
import type { Permission } from "./permission/ask.ts";
import { admitExternalMessage } from "./permission/external-message.ts";
import type { createProvenance } from "./permission/provenance.ts";
import { grantedSource, sourceGrant } from "./permission/provenance/grant.ts";
import type { MessageEnvelope } from "./shared/messages.ts";
import type { Team } from "./team/session.ts";
import { openBacklog } from "./backlog/context.ts";
import { notify } from "./shared/commands.ts";
import { type BranchMerged, mergeWorktreeBranch } from "./worktrees/merge.ts";

/**
 * The ongoing backlog items `sessions` hold on the board of `worktree` (`B3 (ongoing)`): a linked worktree is its own
 * workspace with its own board. None when there are no sessions or the board cannot be read (the merge's other checks
 * still run).
 */
function heldOpenItems(ctx: ExtensionContext, worktree: string, sessions: string[]): string[] {
	if (sessions.length === 0) return [];
	try {
		const { store } = openBacklog({ cwd: worktree, sessionManager: ctx.sessionManager }, { isSubagent: false });
		return store.list({ states: ["ongoing"], assignees: sessions }).items.map((item) => `${item.ref} (${item.state})`);
	} catch {
		return [];
	}
}

/**
 * The checks a message between agents passes, in one place: sending to a teammate, to an outside agent or to another
 * process, and letting one in. Hooks run first, then the permission layer; the plan constraint blocks what leaves this
 * session and asks about what arrives.
 */
export function messagePolicy({
	api,
	hooks,
	permission,
	planning,
	provenance,
	team,
}: {
	api: Pick<ExtensionAPI, "sendMessage">;
	hooks: ReturnType<typeof registerHooks>;
	permission: Permission;
	planning: { blocked(): boolean };
	provenance: ReturnType<typeof createProvenance>;
	team: Pick<Team, "reservation" | "members">;
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
	/** What a worktree merge's readiness check reads: reservations, the agents still working there, the backlog items held there. */
	const readiness = (ctx: ExtensionContext) => ({
		reservation: (file: string, shown: string) => team.reservation(file, shown),
		occupants: () => team.members(),
		openItems: (worktree: string, sessions: string[]) => heldOpenItems(ctx, worktree, sessions),
	});
	// Text from a subagent the user allowed for this session is no provenance hit here either.
	const allowedSource = grantedSource(permission);
	/** A send that starts work elsewhere, by a connection or by a name: a provenance hit and the mode decide, as for a subagent. */
	const authorizeSend = async (
		hit: ReturnType<typeof provenance.sent>,
		request: { title: string; what: string[]; cwd: string; effect: string; grant?: { key: string; label: string } },
		ctx: ExtensionContext,
		signal?: AbortSignal,
	) => {
		const checked = await permission.check(ctx, {
			...(hit
				? {
						reasons: ["provenance" as const],
						reason: hit.why,
						...(hit.agent ? { sourceGrant: sourceGrant(hit.agent) } : {}),
					}
				: {}),
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
				input.action === "prompt" ? provenance.sent(input, ctx, allowedSource) : undefined,
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
				provenance.sent({ text }, ctx, allowedSource),
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
		/**
		 * The model's `coordinate merge`: after the readiness check (`mergeWorktreeBranch`), the `worktree.merge` class asks in
		 * every mode but bypass, because a message never approves a merge. A bypass merge asks nobody, so it is announced in
		 * the transcript and the terminal, and its audit entry says `bypass`.
		 */
		mergeBranch: async (
			branch: string,
			ctx: ExtensionContext,
			signal?: AbortSignal,
		): Promise<{ ok: boolean; text: string; merged?: BranchMerged }> => {
			let bypassed = false;
			const result = await mergeWorktreeBranch(ctx.cwd, branch, {
				...readiness(ctx),
				signal,
				approve: async (what) => {
					const verdict = await permission.check(ctx, {
						action: "worktree.merge",
						title: "Merge this worktree's branch into the main checkout?",
						what,
						purpose: "",
						cwd: ctx.cwd,
						...(signal ? { signal } : {}),
					});
					bypassed = verdict.allowed && verdict.via === "bypass";
					return verdict.allowed ? undefined : verdict.message;
				},
			});
			if (result.ok && result.merged && bypassed) {
				const content = renderInstruction("notices/landing/bypass-merged.md", { merged: result.text });
				void api.sendMessage({ customType: "octocode-merge-notice", content, display: true }, { triggerTurn: false });
				notify(ctx.ui, content, "warning");
			}
			return result;
		},
		/** `/worktree merge <branch>`: consent by typing, so it runs after the readiness check, and the audit still says so. */
		typedMerge: (branch: string, ctx: ExtensionContext) => {
			permission.typed(`/worktree merge ${branch}`, ctx.cwd);
			return mergeWorktreeBranch(ctx.cwd, branch, readiness(ctx));
		},
	};
}
