import { textResultDisplay } from "../../render/display.ts";
import { renderPrompt } from "../../../core/prompt-template.ts";
import { Type } from "typebox";
import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import type { FeatureSetup, FeatureContext } from "../../../core/features/index.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../shared/messages.ts";
import { resultBlock, toolHeader } from "../../render/tool.ts";
import { contentText, firstLine, textResult } from "../../shared/util.ts";
import type { Team } from "../session.ts";
import { PARENT_WAITS_ENV } from "../store/env.ts";
import { timedTool, timingOf } from "../../render/rows.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { liveEndpoints, type LiveTeam } from "../endpoint-live.ts";
import { mailRows, sendOutcome, sendSummary } from "./message-rows.ts";
import { attachmentText } from "../attachment.ts";
import { type HandItem, type SendParams, handAndSend } from "./hand.ts";

/** Shows team mail in the conversation: a header per message, its body previewed while collapsed. */
export function registerMessageRenderer(api: FeatureSetup, team?: LiveTeam): void {
	const endpoints = team ? liveEndpoints(team) : undefined;
	api.renderers.message(INTERNAL_MESSAGE_TYPE, (message, options, theme) =>
		mailRows(message, { ...options, ...(endpoints ? { endpoints } : {}) }, theme),
	);
}

/** The result of `forward`: stored message #N delivered to more agents, or a finished subagent resumed with it. */
async function forwardResult(
	team: Team,
	by: string,
	params: {
		forward?: number;
		to?: string;
		message?: string;
		replyRequired?: boolean;
		interrupt?: boolean;
		wake?: boolean;
		callback?: unknown;
	},
	signal?: AbortSignal,
) {
	if (params.to === undefined) throw new Error("Say who to forward to with `to`.");
	if (
		params.interrupt ||
		params.replyRequired !== undefined ||
		params.callback !== undefined ||
		params.wake !== undefined
	)
		throw new Error(
			"A forward keeps the original message's reply request and never interrupts or wakes; drop those fields.",
		);
	const result = await team.forwardMessage(params.forward!, by, params.to, params.message, signal);
	if ("error" in result) throw new Error(result.error);
	if (result.resumed) return textResult(result.resumed, { to: result.sent, id: result.id });
	const departed = result.departed?.length ? ` Not sent to ${result.departed.join(", ")} (left the team).` : "";
	return textResult(`Forwarded message #${result.id} to ${result.sent.join(", ")}.${departed}`, {
		to: result.sent,
		id: result.id,
		forwarded: true,
		...(result.departed?.length ? { departed: result.departed } : {}),
	});
}

/** Other running Octocode sessions, as a top-level session reaches them; a subagent has none of this. */
export interface PeerRoute {
	addresses(to: string): boolean;
	send(
		to: string,
		text: string,
		options: { replyRequired?: boolean },
		ctx: FeatureContext,
		signal?: AbortSignal,
	): Promise<{ text: string; details: Record<string, unknown> }>;
	/** The other sessions, for `coordinate list`. */
	list(cwd: string): Promise<string>;
}

/**
 * A message to a session another process runs: the text is plain, so a `replyTo` (no message number exists to answer)
 * is dropped and said so; `forward` and `interrupt` would change what is sent, so they are refused, not ignored.
 */
async function sendToPeer(
	peers: PeerRoute,
	params: {
		to: string;
		message?: string;
		forward?: number;
		replyTo?: number;
		interrupt?: boolean;
		replyRequired?: boolean;
		callback?: unknown;
	},
	ctx: FeatureContext,
	signal?: AbortSignal,
) {
	if (params.callback !== undefined)
		throw new Error(`${params.to} is another process: callback reaches teammates only. Nothing was sent.`);
	if (params.forward !== undefined || params.interrupt)
		throw new Error(
			`${params.to} is another process: forward and interrupt reach teammates only. Nothing was sent; call again without them, with your text in message.`,
		);
	if (params.message === undefined) throw new Error("Give message.");
	const { text, details } = await peers.send(
		params.to,
		params.message,
		params.replyRequired ? { replyRequired: true } : {},
		ctx,
		signal,
	);
	if (params.replyTo === undefined) return textResult(text, details);
	return textResult(`${text} replyTo was ignored: it reaches teammates only.`, { ...details, replyToIgnored: true });
}

export function registerSendMessageTool(
	api: FeatureSetup,
	team: Team,
	registerTool: FeatureSetup["tools"]["register"] = (tool) => api.tools.register(tool),
	peers?: PeerRoute,
	hand?: HandItem,
): void {
	/** Sends one message (without a handoff: `handAndSend` puts its notice in front). */
	const deliver = async (params: SendParams, signal: AbortSignal | undefined, ctx: FeatureContext) => {
		// A teammate keeps its name: only a `to` no live agent answers to can be another process.
		const to = params.to;
		if (params.attach && params.forward !== undefined)
			throw new Error("attach goes with a new message, not a forward. Nothing was sent.");
		if (
			to !== undefined &&
			peers?.addresses(to) &&
			!team.members().some((each) => each.id === to || each.role === to)
		) {
			if (params.attach)
				throw new Error(
					`${to} is another process: attach reaches teammates only. Nothing was sent; send the message without it.`,
				);
			return sendToPeer(peers, { ...params, to }, ctx, signal);
		}
		const me = await team.patiently(() => team.join(), signal);
		if (params.forward !== undefined) return forwardResult(team, me.id, params, signal);
		if (params.message === undefined) throw new Error("Give message, or forward with a message number.");
		// The reference leads, so a long message whose tail is saved to a file still delivers it.
		const body = params.attach
			? `${await attachmentText(ctx.cwd, params.attach)}\n\n${params.message}`
			: params.message;
		const result = await team.send(params.to, body, {
			...(signal ? { signal } : {}),
			...(params.replyRequired !== undefined ? { replyRequired: params.replyRequired } : {}),
			...(params.callback ? { callback: params.callback } : {}),
			...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
			...(params.interrupt ? { interrupt: true } : {}),
			...(params.wake !== undefined ? { wake: params.wake } : {}),
		});
		if ("error" in result) throw new Error(result.error);
		const details = {
			to: result.sent,
			id: result.id,
			...(result.delivery ? { delivery: result.delivery } : {}),
			...(result.departed?.length ? { departed: result.departed } : {}),
			...(result.starting?.length ? { starting: result.starting } : {}),
		};
		if (result.resumed) return textResult(result.resumed, details);
		// A foreground child's parent is inside this child's `agent` call: nothing it sends is read before its report.
		const waits =
			process.env[PARENT_WAITS_ENV] === "1" && team.parentId !== undefined && result.sent.includes(team.parentId)
				? ` ${renderPrompt("shared/parent-waits.md")}`
				: "";
		if (result.relayed)
			return textResult(
				`${result.sent.join(", ")} is not a live agent in your team: message #${result.id} goes through your coordinator ${result.relayed}, which resumes it with the message if it is a finished subagent it can resume. If not, you get a notice saying why.`,
				{ ...details, relayed: result.relayed },
			);
		if (params.interrupt)
			return textResult(
				`Interrupt queued for ${result.sent.join(", ")} as message #${result.id}: a busy subagent stops its current step within a second.`,
				details,
			);
		const departed = result.departed?.length ? ` Not sent to ${result.departed.join(", ")} (left the team).` : "";
		const starting = result.starting?.length
			? ` Not reached, still starting: ${result.starting.join(", ")}; send again once they have joined.`
			: "";
		// Only what differs from a plain delivery is told: a woken or busy recipient needs no sentence.
		const delivery = result.delivery ?? {};
		const group = (status: string) => result.sent.filter((recipient) => delivery[recipient] === status);
		const fate = (who: string[], one: string, many: string) =>
			who.length === 0 ? "" : `${who.join(", ")} ${who.length > 1 ? many : one}`;
		const notes = [
			fate(
				group("pull"),
				"reads it only when it fetches its cooperative runner inbox; no turn starts there.",
				"read it only when they fetch their cooperative runner inboxes; no turn starts there.",
			),
			fate(
				group("queued-quiet"),
				"is idle and will not act on it alone; replyRequired: true asks and wakes.",
				"are idle and will not act on it alone; replyRequired: true asks and wakes.",
			),
			fate(
				group("stalled"),
				"has not been seen for over a minute: the message waits, and you are told if it never recovers (it then becomes a dead letter).",
				"have not been seen for over a minute: the message waits, and you are told if they never recover (it then becomes a dead letter).",
			),
		].filter(Boolean);
		const asked = params.replyRequired === true ? " (reply requested)" : "";
		return textResult(
			[`Sent #${result.id} to ${result.sent.join(", ")}${asked}.`, ...notes].join(" ") + departed + starting + waits,
			details,
		);
	};
	registerTool(
		timedTool({
			name: "sendMessage",
			label: "Send message",
			description:
				"Queue steering, questions or evidence to teammates; unread departures are reported. A message resumes your finished non-isolated child (not a runner's) or a lingering one (yours, or siblings via your coordinator).",
			promptGuidelines: renderPrompt("tools/send-message/guidelines.md").split("\n"),
			parameters: Type.Object({
				to: Type.Optional(
					Type.String({
						// Only a top-level session has `peers`; a subagent reaches its own session tree (`resolveTarget`).
						description: peers
							? 'Agent id, role, "parent" (exact ids cross trees), Octocode process name or "all" (your tree); "coordinator" from a linked worktree: the main checkout; omit with replyTo'
							: 'Agent id, role, "parent" (relays beyond) or "all"; omit with replyTo',
					}),
				),
				message: Type.Optional(Type.String()),
				item: Type.Optional(
					Type.String({
						description: "Backlog item for the running child `to` (claimed if unclaimed)",
					}),
				),
				attach: Type.Optional(
					Type.String({
						description: "Worktree text file ≤64 KB, sent by reference",
					}),
				),
				forward: Type.Optional(
					Type.Integer({
						description: "Message # forwarded as is (message: a note); replies go to its sender",
					}),
				),
				replyRequired: Type.Optional(
					Type.Boolean({
						description: "true: ask for an answer, waking recipients; else FYI",
					}),
				),
				callback: Type.Optional(
					Type.Object(
						{
							on: StringEnum(["reply", "done", "item.state", "job.exit", "agent.ended"] as const, {
								description: "What settles it; reply is replyRequired",
							}),
							filter: Type.Optional(
								Type.Object(
									{
										ref: Type.Optional(Type.String()),
										state: Type.Optional(Type.String()),
										job: Type.Optional(Type.String()),
										agent: Type.Optional(Type.String()),
									},
									{ description: "Event fields it must match" },
								),
							),
							note: Type.Optional(Type.String()),
							timeoutMinutes: Type.Optional(Type.Integer({ description: "Else 10 (reply) or 60" })),
						},
						{ description: "Ticket resolved or rejected back to you; more than replyRequired" },
					),
				),
				wake: Type.Optional(
					Type.Boolean({
						description: "Default: wake an idle named agent; false: read next turn. Not with to: all",
					}),
				),
				replyTo: Type.Optional(
					Type.Integer({
						description: "Message # answered: wakes the asker, closes its ask",
					}),
				),
				interrupt: Type.Optional(
					Type.Boolean({
						description: "true: stop its current step; default: next step",
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const { item, ...rest } = params;
				if (item === undefined) return deliver(rest, signal, ctx);
				return handAndSend(hand, rest, item, ctx, (sent) => deliver(sent, signal, ctx));
			},
			// The app and web transcript get the same words as the terminal rows (`message-rows.ts`).
			display(input) {
				const args = asRecord(input.args);
				const summary = sendSummary(args);
				const message = typeof args.message === "string" ? args.message : "";
				const head = { title: "Send", ...(summary ? { summary } : {}), kind: "agent" as const, blocks: [] };
				const details: Record<string, unknown> = asRecord(input.result?.details);
				if (!input.result || input.status === "failed" || typeof details.id !== "number")
					return textResultDisplay(head, input);
				return {
					...head,
					outcome: { text: sendOutcome(args, details) },
					blocks: message ? [{ type: "text" as const, text: message }] : [],
				};
			},
			renderCall(args, theme, context) {
				// Queueing is instant: a millisecond count says nothing, so only a send that took a second or more shows its time.
				const slow = (context.durationMs ?? 0) >= 1_000;
				return toolHeader(
					theme,
					slow ? context : { ...context, durationMs: undefined },
					"Send",
					sendSummary(asRecord(args)),
				);
			},
			renderResult(result, _options, theme, context) {
				const details: Record<string, unknown> = asRecord(result.details);
				const text = contentText(result.content);
				// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
				const message = isRecord(context.args) ? String(context.args.message ?? "") : "";
				const summary = typeof details.id === "number" ? sendOutcome(asRecord(context.args), details) : firstLine(text);
				return resultBlock(theme, context, {
					summary,
					body: context.isError ? text.split("\n").slice(1).join("\n") : message,
					// What was sent is shown whole; an error keeps a short preview.
					...(context.isError ? { max: 3 } : { expanded: true }),
					...timingOf(result.details),
				});
			},
		}),
	);
}
