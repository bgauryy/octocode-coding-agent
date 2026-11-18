import { randomUUID } from "node:crypto";
import { type AgentContext, methods } from "@agentclientprotocol/sdk";
import { withAbort } from "./abort.ts";
import {
	checkedReplies,
	type CancelReason,
	type OptionRole,
	type Question,
	type Reply,
} from "@octocodeai/octocode-contracts";

/**
 * `ui.ask` for an ACP client: a batch of typed questions (`Question`, answered with one `Reply` each). An `approval` is a
 * `session/request_permission` (its roles map to the protocol's option kinds); every other question goes into one
 * `elicitation/create` form when the client offers form elicitation. A client that offers neither answers nothing:
 * every such question is `unavailable`, never `declined`, so the model is told nobody could be asked.
 */

type PermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

/**
 * The protocol's option kind for a role. `allow_always` means the native session grant only: the persistent `allow_kind`
 * grant is never offered through it, so an ACP client cannot make a grant outlive the session. `deny_note` has no kind
 * either: a client cannot take a typed note there.
 */
const KIND_OF_ROLE: Partial<Record<OptionRole, PermissionKind>> = {
	allow_once: "allow_once",
	allow_session: "allow_always",
	deny: "reject_once",
	deny_session: "reject_always",
};

/** What the client was asked, and the abort that ends the wait: the session's turn. */
export interface AskEnvironment {
	client: AgentContext;
	sessionId: string;
	signal: AbortSignal;
	/** The client advertised `elicitation.form`. */
	elicitationForm: boolean;
	/** The person dismissed an approval (the protocol's `cancelled` outcome): the turn must stop before the worker's dialog is released. */
	onCancelled: () => void;
}

const everyone = (questions: readonly Question[], cancelled: CancelReason): Reply[] =>
	questions.map((question) => ({ id: question.id, cancelled }));

/** The write-in's property name beside question `id` in a form. */
const textKey = (id: string): string => `${id}__text`;

const titled = (question: Question) =>
	(question.options ?? []).map((option) => ({
		const: option.id,
		title: option.label,
		...(option.description ? { description: option.description } : {}),
	}));

/** What a timed-out question takes and when, appended to its description: the form has no field for a deadline. */
const deadline = (question: Question): string => {
	const taken = (question.options ?? []).filter((option) => option.recommended).map((option) => option.label);
	return question.timeoutSeconds && taken.length > 0
		? `\n(auto: ${(question.type === "multi" ? taken : taken.slice(0, 1)).join(", ")} in ${question.timeoutSeconds}s)`
		: "";
};

const caption = (question: Question): string => (question.header ?? question.question).split("\n")[0].slice(0, 120);

/** One form for `questions`: a flat object of string, enum and array-of-enum properties, one per question (plus a text property for a write-in). */
function elicitationSchema(questions: readonly Question[]) {
	const ids = new Set(questions.map((question) => question.id));
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const question of questions) {
		const base = { title: caption(question), description: `${question.question}${deadline(question)}` };
		const writeIn = question.writeIn && !ids.has(textKey(question.id)) ? question.writeIn : undefined;
		if (question.type === "text") {
			properties[question.id] = { type: "string", ...base };
			required.push(question.id);
			continue;
		}
		if (question.type === "multi") {
			properties[question.id] = { type: "array", ...base, items: { anyOf: titled(question) } };
		} else {
			properties[question.id] = { type: "string", ...base, oneOf: titled(question) };
			if (!writeIn) required.push(question.id);
		}
		if (writeIn)
			properties[textKey(question.id)] = { type: "string", title: writeIn.label, description: writeIn.title };
	}
	return { type: "object" as const, properties, ...(required.length ? { required } : {}) };
}

const asText = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** The replies a form's accepted `content` stands for; a question the person left empty is declined. */
function repliesFromForm(questions: readonly Question[], content: Record<string, unknown> | null | undefined): Reply[] {
	return questions.map((question): Reply => {
		const value = content?.[question.id];
		const text = asText(content?.[textKey(question.id)]);
		if (question.type === "text") {
			const typed = asText(value);
			return typed ? { id: question.id, picks: [], text: typed } : { id: question.id, cancelled: "declined" };
		}
		const offered = new Set((question.options ?? []).map((option) => option.id));
		const chosen = (Array.isArray(value) ? value : [value]).filter(
			(pick): pick is string => typeof pick === "string" && offered.has(pick),
		);
		const picks = question.type === "multi" ? chosen : chosen.slice(0, 1);
		if (picks.length === 0 && !text) return { id: question.id, cancelled: "declined" };
		return { id: question.id, picks, ...(text ? { text } : {}) };
	});
}

/** One approval through `session/request_permission`; undefined when its options cannot be offered (no allow-once and deny). */
async function askApproval(env: AskEnvironment, question: Question): Promise<Reply> {
	const offered = (question.options ?? []).flatMap((option) => {
		const kind = option.role ? KIND_OF_ROLE[option.role] : undefined;
		return kind ? [{ optionId: option.id, name: option.label, kind }] : [];
	});
	if (!offered.some((o) => o.kind === "allow_once") || !offered.some((o) => o.kind === "reject_once"))
		return { id: question.id, cancelled: "unavailable" };
	const targets = question.approval?.targets.length
		? question.approval.targets.join("\n")
		: (question.body?.text ?? "");
	const response = await withAbort(
		env.signal,
		env.client.request(
			methods.client.session.requestPermission,
			{
				sessionId: env.sessionId,
				toolCall: {
					toolCallId: question.approval?.toolCallId ?? randomUUID(),
					title: question.question,
					status: "pending",
					kind: "other",
					name: question.approval?.toolName,
					content: [{ type: "content", content: { type: "text", text: targets } }],
				},
				options: offered,
			},
			{ cancellationSignal: env.signal },
		),
	);
	if (env.signal.aborted) return { id: question.id, cancelled: "aborted" };
	const outcome = (response as { outcome: { outcome: string; optionId?: string } }).outcome;
	if (outcome.outcome === "cancelled") {
		env.onCancelled();
		return { id: question.id, cancelled: "aborted" };
	}
	const picked = outcome.optionId ?? "";
	// A client answering with an id it was never offered decides nothing.
	return offered.some((option) => option.optionId === picked)
		? { id: question.id, picks: [picked] }
		: { id: question.id, cancelled: "declined" };
}

/** The non-approval questions as one elicitation form. */
async function askForm(env: AskEnvironment, questions: readonly Question[]): Promise<Reply[]> {
	const response = await withAbort(
		env.signal,
		env.client.request(
			methods.client.elicitation.create,
			{
				mode: "form",
				sessionId: env.sessionId,
				message: questions.length === 1 ? questions[0].question : "Octocode needs your input.",
				requestedSchema: elicitationSchema(questions),
			},
			{ cancellationSignal: env.signal },
		),
	);
	if (env.signal.aborted) return everyone(questions, "aborted");
	if (response.action === "accept")
		return repliesFromForm(questions, response.content as Record<string, unknown> | null | undefined);
	return everyone(questions, response.action === "decline" ? "declined" : "aborted");
}

/** `run`'s result; when the turn was aborted meanwhile, `aborted` (the client request was cancelled, which is no failure). */
async function unlessAborted<T>(env: AskEnvironment, aborted: T, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (env.signal.aborted) return aborted;
		throw error;
	}
}

/**
 * The replies of the person at the ACP client. Approvals are asked one at a time, the other questions together; a
 * client error is not an answer and propagates (the session reports it). Replies are checked against the questions
 * before they leave: one that does not fit declines the whole batch.
 */
export async function askClient(env: AskEnvironment, questions: Question[]): Promise<Reply[]> {
	const byId = new Map<string, Reply>();
	const rest = questions.filter((question) => question.type !== "approval");
	for (const question of questions) {
		if (question.type !== "approval") continue;
		const aborted: Reply = { id: question.id, cancelled: "aborted" };
		byId.set(question.id, await unlessAborted(env, aborted, () => askApproval(env, question)));
	}
	if (rest.length > 0) {
		const replies = env.elicitationForm
			? await unlessAborted(env, everyone(rest, "aborted"), () => askForm(env, rest))
			: everyone(rest, "unavailable");
		for (const reply of replies) byId.set(reply.id, reply);
	}
	const replies = questions.map(
		(question) => byId.get(question.id) ?? { id: question.id, cancelled: "declined" as const },
	);
	return checkedReplies(questions, replies) ?? everyone(questions, "declined");
}
