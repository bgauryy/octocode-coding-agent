import type { PermissionUpdateCommit } from "../../shared/permission-updates.ts";
import type { ToolInvocation } from "../../../core/features/types.ts";
import { interactive } from "../../shared/interactive.ts";
import { withDialog } from "../../shared/locks.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { SourceDecision } from "../source-policy/rules.ts";
import { shellTargetAccess } from "../file-access.ts";
import { commandWriteTargets } from "../shell/write-targets.ts";
import { computeCard } from "../effect.ts";
import { type ActionClass, decide, kindOf, type PermissionMode, UNGRANTABLE } from "../mode.ts";
import type { PermissionRequest } from "../request.ts";
import { grantableSource, sourceGrantKey } from "../provenance/grant.ts";
import { type Snapshot, takeSnapshot } from "../snapshot.ts";
import { deniedMessage, DISMISSED, forcingReasons, headlessMessage, withPurpose } from "./text.ts";
import type { Asker, Dialog, PermissionResolver, PrepareUpdates, ReplacementCheck, Verdict, Decided } from "./types.ts";

/** What the check pipeline needs of its `Permission`: live reads of its state, its grants and its audit step. */
export interface CheckHost {
	mode(): PermissionMode;
	/** The current policy controller: it is replaced whenever the grants or the source policy change. */
	policy(): AbortController;
	answeredSourceAsks(): WeakSet<ToolInvocation>;
	resolver(): PermissionResolver | undefined;
	prepareUpdates(): PrepareUpdates | undefined;
	readonly spawnGrants: ReadonlySet<ActionClass>;
	readonly kinds: Set<ActionClass>;
	readonly grants: Map<string, string>;
	/** The user's "Deny <label> for this session" answers, by grant key: given in place of the dialog they would answer. */
	readonly denials: Map<string, string>;
	readonly snapshotMs: number | undefined;
	/** How long a card line may take to compute; omitted: the product default. */
	readonly cardBudgetMs?: number;
	readonly relay: boolean;
	readonly isSubagent: boolean;
	readonly select: Dialog;
	replacementSourceDecision(invocation: ToolInvocation, cwd: string, indices?: number[]): SourceDecision | undefined;
	decided(request: PermissionRequest, verdict: Decided, note?: string, snapshot?: Snapshot): Decided;
}

/** A `file` call reduced to the queries at `indices`; undefined when the call is not one or no indices apply. */
export function selectedFileQueries(invocation: ToolInvocation, indices?: number[]): ToolInvocation | undefined {
	const { input } = invocation;
	if (!indices || invocation.toolName !== "file" || !isRecord(input) || !Array.isArray(input.queries)) return undefined;
	return { ...invocation, input: { ...input, queries: input.queries.filter((_query, at) => indices.includes(at)) } };
}

/** The check behind `Permission.check` and its replacement variants: mode table, session grants, then the dialog. */
export async function checkPermission(
	base: CheckHost,
	ctx: Asker,
	call: PermissionRequest,
	dialog?: Dialog,
	transaction?: ReplacementCheck,
): Promise<Verdict> {
	// An early call's audit entries wait until the call is committed (`PermissionRequest.early`).
	const early = call.early;
	const host: CheckHost = early
		? {
				...base,
				decided: (request, verdict, note, snapshot) => {
					early.park(() => void base.decided(request, verdict, note, snapshot));
					return verdict;
				},
			}
		: base;
	let request = withPurpose(ctx, call);
	if (request.signal?.aborted)
		return host.decided(request, {
			allowed: false,
			via: "cancelled",
			message: DISMISSED,
		});
	const invocation =
		request.invocation ??
		(request.toolCallId && ctx.invocation?.toolCallId === request.toolCallId ? ctx.invocation : undefined);
	const source = invocation?.active
		? host.replacementSourceDecision(invocation, request.cwd ?? ctx.cwd ?? process.cwd(), transaction?.fileIndices)
		: undefined;
	if (source?.decision === "deny" || source?.decision === "unsupported")
		return host.decided(request, {
			allowed: false,
			via: "policy",
			message: source.message ?? "Source permission policy refused this call",
		});
	if (source?.decision === "ask" && invocation && !host.answeredSourceAsks().has(invocation))
		request = {
			...request,
			reasons: [...(request.reasons ?? []), "source.ask"],
			reason: [request.reason, source.message].filter(Boolean).join("\n"),
		};
	const targetClasses = new Set<ActionClass>();
	const cwd = request.cwd ?? ctx.cwd ?? process.cwd();
	// The source policy's redirect and `tee` targets (with its rule verdicts), then every other place the command writes.
	const shellTargets = [
		...(source?.shellTargets ?? []),
		...(invocation ? commandWriteTargets(invocation, cwd, source?.shellTargets) : []),
	];
	for (const target of shellTargets) {
		const access = shellTargetAccess(target, cwd);
		if (access.refusal)
			return host.decided(request, {
				allowed: false,
				via: "policy",
				message: access.refusal,
			});
		// One reason line per card, however many targets are unresolved; this is the only place that adds the reason.
		if (
			access.uncertain &&
			!(source?.shellBroadAllowance && target.uncertain === "dynamic file target") &&
			!request.reasons?.includes("shell.target")
		)
			request = {
				...request,
				reasons: [...(request.reasons ?? []), "shell.target"],
				reason: [request.reason, "Bash file target cannot be resolved before execution"].filter(Boolean).join("\n"),
			};
		if ((!target.allowed || access.protected) && !(source?.shellBroadAllowance && !access.protected) && access.action)
			targetClasses.add(access.action);
	}
	if (targetClasses.size)
		request = {
			...request,
			// Only a class that asks in this mode joins the dialog: one that is allowed anyway must not take its session answer away.
			also: [
				...new Set([
					...(request.also ?? []),
					...[...targetClasses].filter((each) => decide(request.asMode ?? host.mode(), each) === "ask"),
				]),
			],
			what: [...request.what, ...shellTargets.map((target) => `${target.kind} ${target.raw}`)],
		};
	const signal = request.signal ? AbortSignal.any([request.signal, host.policy().signal]) : host.policy().signal;
	const action = request.action;
	const forced = (): boolean => forcingReasons(host.mode(), request).length > 0;
	const classes = [...(action ? [action] : []), ...(request.also ?? [])];
	const grant = action && !forced() && !UNGRANTABLE.has(action) && classes.length === 1 ? request.grant : undefined;
	const grantKey = grant ? `${action}\0${grant.key}` : undefined;
	// The one session answer a forcing reason has: its provenance hit came from a subagent, and that source is allowed from now on.
	const sourceAllow = grantableSource(call, forcingReasons(host.mode(), request));
	let grantNote: string | undefined;
	let snapshot: Snapshot | undefined;
	const snap = async (): Promise<void> => {
		if (action === "shell.destructive" && !snapshot)
			snapshot = await takeSnapshot(
				request.cwd ?? process.cwd(),
				host.snapshotMs === undefined ? {} : { timeoutMs: host.snapshotMs },
			);
	};
	/** Set when the dialog is about to be shown: the audit entry records how long the user took. */
	const shown: { at?: number } = {};
	const decided = (verdict: Decided, note?: string): Decided => {
		if (verdict.allowed && source?.decision === "ask" && invocation?.active) host.answeredSourceAsks().add(invocation);
		const answered = shown.at === undefined ? request : { ...request, askedAt: shown.at };
		return host.decided(answered, verdict, note ?? transaction?.auditNote ?? grantNote, snapshot);
	};
	const completeAllowed = async (
		verdict: Extract<Verdict, { allowed: true }>,
		updates = transaction?.updatedPermissions,
	): Promise<Verdict> => {
		let publishUpdates: PermissionUpdateCommit | undefined;
		try {
			if (updates?.length) {
				const prepareUpdates = host.prepareUpdates();
				if (!prepareUpdates) throw new Error("Permission updates are unavailable; call not executed");
				publishUpdates = await prepareUpdates(ctx, updates, signal);
			}
		} catch (error) {
			return decided({ allowed: false, via: "policy", message: errorMessage(error) });
		}
		await snap();
		if (signal.aborted || (invocation && !invocation.active))
			return decided({
				allowed: false,
				via: "cancelled",
				message: DISMISSED,
			});
		try {
			await transaction?.commit?.(signal, source);
		} catch (error) {
			return decided({
				allowed: false,
				via: "policy",
				message: errorMessage(error),
			});
		}
		if (signal.aborted || (invocation && !invocation.active))
			return decided({
				allowed: false,
				via: "cancelled",
				message: DISMISSED,
			});
		let committedPolicy = host.policy();
		try {
			await publishUpdates?.(signal, (change) => {
				signal.throwIfAborted();
				if (invocation && !invocation.active) throw new Error(DISMISSED);
				change();
				committedPolicy = host.policy();
			});
		} catch (error) {
			return decided({ allowed: false, via: signal.aborted ? "cancelled" : "policy", message: errorMessage(error) });
		}
		if (request.signal?.aborted || (invocation && !invocation.active) || host.policy() !== committedPolicy)
			return decided({ allowed: false, via: "cancelled", message: DISMISSED });
		return decided(
			verdict,
			updates?.length
				? [transaction?.auditNote, `PermissionRequest applied updates: ${JSON.stringify(updates)}`]
						.filter(Boolean)
						.join("\n")
				: undefined,
		);
	};
	const rule = (each: ActionClass) => decide(request.asMode ?? host.mode(), each);
	const automatic = (): Verdict | undefined => {
		if (signal.aborted)
			return decided({
				allowed: false,
				via: "cancelled",
				message: DISMISSED,
			});
		// A forcing reason (provenance, a hook ask) needs a person, even for a replacement a hook already approved.
		if (forced()) return undefined;
		if (transaction?.inheritedHookApproval && source?.decision !== "ask")
			return { allowed: true, via: "hook", lasts: "call" };
		const sourceAllows =
			source?.decision === "allow" &&
			!classes.some((each) => ["net.private", "upload.outside", "agent.spawn", "worktree.merge"].includes(each));
		if (sourceAllows && [...targetClasses].every((each) => rule(each) === "allow"))
			return { allowed: true, via: "policy", lasts: "call" };
		// A class full asks about is allowed only in bypass: the audit says `bypass`, not `mode`.
		const bypassOnly = classes.some((each) => decide("full", each) !== "allow");
		if (classes.every((each) => rule(each) === "allow"))
			return { allowed: true, via: bypassOnly ? "bypass" : "mode", lasts: "call" };
		const covered = (each: ActionClass): boolean =>
			(sourceAllows && !targetClasses.has(each)) ||
			rule(each) === "allow" ||
			host.spawnGrants.has(each) ||
			host.kinds.has(each) ||
			(each === action && grantKey !== undefined && host.grants.has(grantKey));
		return classes.every(covered) ? { allowed: true, via: "grant", lasts: "session" } : undefined;
	};
	const ready = automatic();
	if (ready) return ready.allowed ? completeAllowed(ready) : ready;
	// Anything past this point can open a dialog; an early call waits for its message to end instead.
	if (early)
		return {
			allowed: false,
			via: "deferred",
			message: "An early call that needs an answer waits for its message to end",
		};
	// The user's remembered "Deny <label> for this session": the answer a dialog would get, so only where one would be shown.
	const remembered = (): Verdict | undefined => {
		const denied = grantKey === undefined ? undefined : host.denials.get(grantKey);
		if (denied === undefined) return undefined;
		const message = deniedMessage(request, host.mode(), undefined);
		return decided(
			{ allowed: false, via: "user", message, lasts: "session" },
			`The user's answer for this session: ${denied}`,
		);
	};
	if (source?.dontAsk)
		return decided({ allowed: false, via: "policy", message: "Claude dontAsk mode refuses this unapproved call" });
	const resolver = host.resolver();
	if (invocation?.active && resolver && !transaction?.inheritedHookApproval) {
		const answer = await resolver(ctx, invocation, signal);
		if (signal.aborted || !invocation.active)
			return decided({
				allowed: false,
				via: "cancelled",
				message: DISMISSED,
			});
		if (answer) {
			if (answer.decision === "allow") {
				if (answer.updatedInput !== undefined || answer.updatedFileInputs !== undefined) {
					if (!(answer.updatedFileInputs !== undefined ? transaction?.prepareFile : transaction?.prepare))
						return decided({
							allowed: false,
							via: "policy",
							message:
								"PermissionRequest input replacement requires a supported Bash or file-query transaction; call not executed",
						});
					try {
						const prepared =
							answer.updatedFileInputs !== undefined
								? await transaction!.prepareFile!(answer.updatedFileInputs)
								: await transaction!.prepare!(answer.updatedInput!);
						if (signal.aborted || !invocation.active)
							return decided({
								allowed: false,
								via: "cancelled",
								message: DISMISSED,
							});
						return await checkPermission(host, ctx, prepared.request, dialog, {
							inheritedHookApproval: true,
							updatedPermissions: answer.updatedPermissions,
							commit: prepared.commit,
							fileIndices: prepared.fileIndices,
							auditNote: `PermissionRequest replaced original input: ${JSON.stringify(invocation.input)}`,
						});
					} catch (error) {
						return decided({
							allowed: false,
							via: "policy",
							message: errorMessage(error),
						});
					}
				}
				// The per-call tripwires (a provenance hit, a hook ask) need a person even when a permission hook allows: the
				// dialog or refusal follows. A source ask is the hook's to answer.
				const tripwire = forcingReasons(host.mode(), request).some(
					(each) => each === "provenance" || each === "hook.ask",
				);
				if (!tripwire) return completeAllowed({ allowed: true, via: "hook", lasts: "call" }, answer.updatedPermissions);
			} else {
				const result = decided(
					{
						allowed: false,
						via: "hook",
						message: deniedMessage(request, host.mode(), answer.message),
					},
					answer.message,
				);
				if (answer.interrupt) ctx.abort?.("internal");
				return result;
			}
		}
	}
	const refused = remembered();
	if (refused) return refused;
	// A relayed child asks its parent through its own dialogs; any other subagent has no one to ask.
	if (!(host.relay ? ctx.hasUI : interactive(ctx, host.isSubagent)))
		return decided({
			allowed: false,
			via: "headless",
			message: headlessMessage(request, host.mode(), host.isSubagent),
		});
	await snap();
	const asked: PermissionRequest = {
		...request,
		...(await computeCard(request, snapshot, host.cardBudgetMs)),
		signal,
		...(grant ? { grant } : {}),
	};
	if (!grant) delete asked.grant;
	shown.at = Date.now();
	request.onAsk?.();
	return withDialog(async () => {
		// A preceding dialog may have granted this scope while this call waited. A forcing reason is never granted.
		const now = automatic();
		if (now) return now.allowed ? completeAllowed(now) : now;
		const deniedMeanwhile = remembered();
		if (deniedMeanwhile) return deniedMeanwhile;
		const answer = await (dialog ?? host.select)(ctx, asked);
		if (answer === undefined || signal.aborted)
			return decided({
				allowed: false,
				via: "cancelled",
				message: DISMISSED,
			});
		if (answer === "session" && sourceAllow) {
			host.grants.set(sourceGrantKey(sourceAllow), sourceAllow.label);
			grantNote = `The user allowed ${sourceAllow.label} for this session`;
		} else if (answer === "session") {
			if (!grant || !grantKey)
				return decided({
					allowed: false,
					via: "cancelled",
					message: DISMISSED,
				});
			host.grants.set(grantKey, grant.label);
		}
		if (answer === "deny_session") {
			if (!grant?.deniable || !grantKey) return decided({ allowed: false, via: "cancelled", message: DISMISSED });
			host.denials.set(grantKey, `denied ${grant.label}`);
		}
		if (answer === "kind") {
			if (!action || forced() || classes.length > 1 || kindOf(action) === undefined)
				return decided({
					allowed: false,
					via: "cancelled",
					message: DISMISSED,
				});
			host.kinds.add(action);
		}
		if (answer === "once" || answer === "session" || answer === "kind")
			return completeAllowed({
				allowed: true,
				via: "user",
				lasts: answer === "once" ? "call" : "session",
			});
		const note = typeof answer === "object" ? answer.deny : undefined;
		const message = deniedMessage(request, host.mode(), note);
		if (answer === "deny_session") return decided({ allowed: false, via: "user", message, lasts: "session" }, note);
		return decided({ allowed: false, via: "user", message }, note);
	}, signal);
}
