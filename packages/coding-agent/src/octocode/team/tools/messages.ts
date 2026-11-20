import { textResultDisplay } from "../../render/display.ts";
import { renderPrompt } from "../../../core/prompt-template.ts";
import { Type } from "typebox";
import type { FeatureSetup, FeatureContext } from "../../../core/features/index.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../shared/messages.ts";
import { resultBlock, toolHeader } from "../../render/tool.ts";
import { contentText, firstLine, textResult } from "../../shared/util.ts";
import type { Team } from "../session.ts";
import { PARENT_WAITS_ENV } from "../store/env.ts";
import { WAKE_INTERVAL_MS } from "../wake-pace.ts";
import { timedTool, timingOf } from "../../render/rows.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { liveEndpoints, type LiveTeam } from "../endpoint-live.ts";
import { mailRows, sendOutcome, sendSummary } from "./message-rows.ts";
import { attachmentText } from "../attachment.ts";

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
	},
	signal?: AbortSignal,
) {
	if (params.to === undefined) throw new Error("Say who to forward to with `to`.");
	if (params.interrupt || params.replyRequired !== undefined || params.wake !== undefined)
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
	},
	ctx: FeatureContext,
	signal?: AbortSignal,
) {
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
): void {
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
							? 'Agent id, role or "parent" (exact ids cross trees); "all": your tree; omit with replyTo: its sender. Also an Octocode process name, or from a linked worktree "coordinator" (the main checkout session; none or several: nothing sent).'
							: 'Agent id, role or "parent" in your tree; parent relays beyond it. "all": whole tree. Omit with replyTo: its sender.',
					}),
				),
				message: Type.Optional(Type.String()),
				attach: Type.Optional(
					Type.String({
						description: "Text file in your worktree (≤64 KB) sent by reference; the recipient writes it by sha256",
					}),
				),
				forward: Type.Optional(
					Type.Integer({
						description:
							"Stored message # passed on unchanged (message: optional note); replies go to its sender. Teammates only",
					}),
				),
				replyRequired: Type.Optional(
					Type.Boolean({
						description: "true: asks for an answer, waking each recipient (all: whole tree); default: FYI",
					}),
				),
				wake: Type.Optional(
					Type.Boolean({
						description:
							"Default: a new message starts an idle named agent's turn, paced; false: read at its next turn. Not with to: all",
					}),
				),
				replyTo: Type.Optional(
					Type.Integer({
						description:
							"Message number answered: wakes the asker, closes its ask (a broadcast closes none). Teammates only",
					}),
				),
				interrupt: Type.Optional(
					Type.Boolean({
						description:
							"true: stop the recipient's current step (starter only; with to: all, every recipient must be your subagent); default: its next step. Teammates only",
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
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
				const me = team.join();
				if (params.forward !== undefined) return forwardResult(team, me.id, params, signal);
				if (params.message === undefined) throw new Error("Give message, or forward with a message number.");
				// The reference leads, so a long message whose tail is saved to a file still delivers it.
				const body = params.attach
					? `${await attachmentText(ctx.cwd, params.attach)}\n\n${params.message}`
					: params.message;
				const result = await team.send(params.to, body, {
					...(signal ? { signal } : {}),
					...(params.replyRequired !== undefined ? { replyRequired: params.replyRequired } : {}),
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
				const recipients = result.sent.join(", ");
				// Told as it meets each recipient, so a sender knows an idle one will not act on an FYI alone, and which one is not answering.
				const delivery = result.delivery ?? {};
				const group = (status: string) => result.sent.filter((recipient) => delivery[recipient] === status);
				const pull = group("pull");
				const fate = (who: string[], one: string, many: string) =>
					who.length === 0 ? "" : `${who.join(", ")} ${who.length > 1 ? many : one}`;
				const stalled = fate(
					group("stalled"),
					"has not been seen for over a minute: the message waits, and you are told if it never recovers (it then becomes a dead letter).",
					"have not been seen for over a minute: the message waits, and you are told if they never recover (it then becomes a dead letter).",
				);
				// An answer to the recipient's own question is never paced; any other agent-started turn is.
				const pace =
					params.replyTo === undefined && group("wake").length > 0
						? `Agent-started turns are paced (at most one per ${WAKE_INTERVAL_MS / 1000}s; mail meanwhile joins that turn).`
						: "";
				if (params.replyRequired === true)
					return textResult(
						`Queued message #${result.id} for ${recipients} as a request: ${pull.length ? `${pull.join(", ")} must fetch their cooperative inbox; no turn is started there` : `${recipients} ${result.sent.length > 1 ? "are" : "is"} woken`} and must answer with replyTo ${result.id}.${departed}${starting}${[
							pace,
							stalled,
						]
							.filter(Boolean)
							.map((part) => ` ${part}`)
							.join("")}${waits}`,
						details,
					);
				const fates = [
					pull.length
						? `${pull.join(", ")} reads it only when it fetches its cooperative runner inbox; this does not wake or resume the task.`
						: "",
					fate(
						group("wake"),
						"is woken: a turn starts if it is idle, otherwise it reads the message at its next step.",
						"are woken: a turn starts for each idle one, otherwise they read the message at their next steps.",
					),
					pace,
					fate(group("next-step"), "reads it at its next step.", "read it at their next steps."),
					fate(
						group("queued-quiet"),
						"is idle: it reads this on its next turn and will not act on it alone; replyRequired: true asks and wakes.",
						"are idle: they read this on their next turn and will not act on it alone; replyRequired: true asks and wakes.",
					),
					stalled,
				]
					.filter(Boolean)
					.join(" ");
				return textResult(
					[`Queued message #${result.id} for ${recipients} as an FYI (no reply requested).`, fates]
						.filter(Boolean)
						.join(" ") +
						departed +
						starting +
						waits,
					details,
				);
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
