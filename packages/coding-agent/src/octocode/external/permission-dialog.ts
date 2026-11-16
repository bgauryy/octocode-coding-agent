import type { Question } from "@octocodeai/octocode-contracts";
import type { ExtensionContext } from "../../core/features/index.ts";
import { interactive } from "../shared/interactive.ts";
import { ask } from "../ask/ask.ts";
import { permissionAnswer } from "../ask/decode.ts";
import { redactSecrets, visibleControls } from "@octocodeai/octocode-common/sanitize";
import type { ExternalPolicy } from "./manager.ts";

/** What each ACP option kind means to the person: only these two are offered. */
const DESCRIPTIONS = {
	allow_once: "only this one; the agent asks again next time",
	reject_once: "the agent is told you refused",
} as const;

type Offered = { optionId: string; name: string; kind: "allow_once" | "reject_once" };

/**
 * An external ACP agent's permission request as an approval card: the call's title as the question, its details (secrets
 * redacted, control characters shown; whole, since they are what the person approves) as the body, one option per offered
 * kind with the role it means (`allow_once`, `deny`). Option ids are positions, so two options of one kind stay apart.
 */
function externalApproval(
	request: Parameters<ReturnType<ExternalPolicy["permission"]>>[0],
	options: readonly Offered[],
): Question {
	const details = visibleControls(redactSecrets(JSON.stringify(request.toolCall, null, 2)));
	const title = request.toolCall.title ? visibleControls(request.toolCall.title) : "";
	// A host without cards answers with a label, so two options never share one: the agent names them, and a repeated name
	// must not let a refusal read as the grant beside it.
	const seen = new Set<string>();
	const labels = options.map((option, index) => {
		const name = visibleControls(option.name);
		const label = seen.has(name) ? `${name} (${index + 1})` : name;
		seen.add(label);
		return label;
	});
	return {
		id: "external-permission",
		type: "approval",
		question: title || "External agent permission",
		meta: ["External agent permission request"],
		body: { text: details },
		options: options.map((option, index) => ({
			id: String(index),
			label: labels[index],
			description: DESCRIPTIONS[option.kind],
			role: option.kind === "allow_once" ? "allow_once" : "deny",
			...(option.kind === "reject_once" ? { tone: "danger" as const } : {}),
		})),
		approval: { toolCallId: request.toolCall.toolCallId, toolName: "external", targets: [details] },
	};
}

/**
 * An external ACP agent's permission request, put to the person: only `allow_once` and `reject_once` are offered (a
 * standing grant would outlive this prompt), through the one dialog queue. The answer is read by the option's role,
 * never its name. With nobody to ask (no UI), the request is refused through its `reject_once` option, so the agent is
 * told it was refused rather than having its turn cancelled. An abort or no answer cancels.
 */
export const externalPermissionDialog: ExternalPolicy["permission"] =
	(ctx: ExtensionContext) => async (request, signal) => {
		const cancelled = { outcome: { outcome: "cancelled" as const } };
		if (signal.aborted) return cancelled;
		const options = request.options.filter(
			(option): option is Offered => option.kind === "allow_once" || option.kind === "reject_once",
		);
		if (!interactive(ctx, false)) {
			const reject = options.find((option) => option.kind === "reject_once");
			return reject ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } } : cancelled;
		}
		if (options.length === 0) return cancelled;
		const question = externalApproval(request, options);
		// An external agent may ask while no run is active; a person is still what it waits for.
		const [reply] = await ask(ctx, [question], { signal, blocking: true });
		if (signal.aborted || !permissionAnswer(question, reply)) return cancelled;
		const picked = reply && "picks" in reply ? options[Number(reply.picks[0])] : undefined;
		return picked ? { outcome: { outcome: "selected" as const, optionId: picked.optionId } } : cancelled;
	};

/** The part of the session's permission state the external policy needs; `Permission` fits it (external sits below permission). */
interface ExternalPermissionPort {
	readonly mode: string;
	check(
		ctx: ExtensionContext,
		request: { action: "agent.spawn"; title: string; what: string[]; purpose: string; signal: AbortSignal },
	): Promise<{ allowed: boolean }>;
}

/**
 * The policy the session installs: in `full` the external agent's request needs no prompt, so it never waits on a
 * person who may not be there. The `allow_once` option it advertised is selected and the decision is audited through
 * the permission layer like every full-mode call (`bypass` too: it asks less than `full`). Any other mode, and a request with no `allow_once` option, goes to
 * the dialog.
 */
export const externalPermission =
	(permission: ExternalPermissionPort): ExternalPolicy["permission"] =>
	(ctx: ExtensionContext) => {
		const dialog = externalPermissionDialog(ctx);
		return async (request, signal) => {
			const allow = request.options.find((option) => option.kind === "allow_once");
			if (!allow || (permission.mode !== "full" && permission.mode !== "bypass") || signal.aborted)
				return dialog(request, signal);
			const verdict = await permission.check(ctx, {
				action: "agent.spawn",
				title: "Let this external agent proceed?",
				what: [visibleControls(redactSecrets(JSON.stringify(request.toolCall)))],
				purpose: "",
				signal,
			});
			if (!verdict.allowed) return dialog(request, signal);
			return { outcome: { outcome: "selected" as const, optionId: allow.optionId } };
		};
	};
