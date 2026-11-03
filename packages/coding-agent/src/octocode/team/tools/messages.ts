import { Box, Text } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/features/index.ts";
import { formatClock } from "../../shared/format.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../shared/messages.ts";
import { resultBlock, toolHeader } from "../../shared/render.ts";
import { contentText, firstLine, textResult } from "../../shared/util.ts";
import type { MailDetails } from "../model.ts";
import type { Team } from "../session.ts";
import { WAKE_INTERVAL_MS } from "../wake-pace.ts";
import { clip, plural } from "../../shared/render/text.ts";
import { timedTool, timingOf } from "../../shared/render/rows.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";

/** Columns of the sent text shown on the collapsed Send row. */
const PREVIEW_CHARS = 60;

/** Shows team mail in the conversation. */
export function registerMessageRenderer(api: ExtensionAPI): void {
	// Agent messages are shown in full, collapsed or not: they are short (a long one arrives as its start plus a file path) and the user reads them.
	api.registerMessageRenderer(INTERNAL_MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const mail = (message.details as Partial<MailDetails> | undefined)?.messages;
		const box = new Box(outputPad ?? 1, 0);
		// Details are another process's data: anything but a batch shows the text the model got.
		const entries = Array.isArray(mail)
			? mail
			: [{ from: "agent", text: typeof message.content === "string" ? message.content : "", at: Date.now() }];
		for (const entry of entries) {
			// The sender's role and goal are already on its Agent row; the number is what `replyTo` takes.
			// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- details are another process's data
			const from = clip(String(entry?.from ?? "agent"), 64);
			const meta = [
				typeof entry?.id === "number" ? `#${entry.id}` : "",
				formatClock(entry?.at ?? Date.now()),
				entry?.replyRequired ? "reply requested" : "",
			].filter(Boolean);
			box.addChild(
				new Text(
					`${theme.fg("accent", "✉")} ${theme.fg("toolTitle", theme.bold(from))} ${theme.fg("dim", `→ you · ${meta.join(" · ")}`)}`,
					0,
					0,
				),
			);
			// resultBlock sanitizes the body.
			box.addChild(
				// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- details are another process's data
				resultBlock(theme, { expanded: true }, { summary: "", body: String(entry?.text ?? ""), error: false }),
			);
		}
		return box;
	});
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

/** The `sendMessage` tool. */
export function registerSendMessageTool(
	api: ExtensionAPI,
	team: Team,
	registerTool: ExtensionAPI["registerTool"] = (tool) => api.registerTool(tool),
): void {
	registerTool(
		timedTool({
			name: "sendMessage",
			label: "Send message",
			description:
				"Queue steering, questions or evidence to teammates; unread departures are reported. Messages resume only reachable non-isolated background children (yours, or siblings via your parent).",
			promptGuidelines: [
				"Send self-contained blockers, decisions or evidence that change the next step. Skip acknowledgements and completion pings; reports arrive automatically.",
			],
			parameters: Type.Object({
				to: Type.Optional(
					Type.String({
						description:
							'Agent id, role or "parent"; use an exact id across parent trees. "all" reaches only your tree; omit with replyTo to answer its sender.',
					}),
				),
				message: Type.Optional(Type.String()),
				forward: Type.Optional(
					Type.Integer({
						description:
							"Stored message # to pass on unchanged (msg#N elsewhere); message becomes an optional note; replies go to its sender.",
					}),
				),
				replyRequired: Type.Optional(
					Type.Boolean({
						description: "true: a request you need answered; wakes an idle recipient. Default false: an FYI",
					}),
				),
				wake: Type.Optional(
					Type.Boolean({
						description: "true: an idle recipient acts now, no answer expected (an FYI waits). Not with to: all",
					}),
				),
				replyTo: Type.Optional(
					Type.Integer({
						description: "Message number to answer; wakes the asker.",
					}),
				),
				interrupt: Type.Optional(
					Type.Boolean({
						description:
							"true: stop the recipient's current step for this message; only its starter may. Default: deliver at its next step.",
					}),
				),
			}),
			async execute(_id, params, signal) {
				signal?.throwIfAborted();
				const me = team.join();
				if (params.forward !== undefined) return forwardResult(team, me.id, params, signal);
				if (params.message === undefined) throw new Error("Give message, or forward with a message number.");
				const result = await team.send(params.to, params.message, {
					...(signal ? { signal } : {}),
					...(params.replyRequired !== undefined ? { replyRequired: params.replyRequired } : {}),
					...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
					...(params.interrupt ? { interrupt: true } : {}),
					...(params.wake ? { wake: true } : {}),
				});
				if ("error" in result) throw new Error(result.error);
				const details = {
					to: result.sent,
					id: result.id,
					...(result.delivery ? { delivery: result.delivery } : {}),
					...(result.departed?.length ? { departed: result.departed } : {}),
				};
				if (result.resumed) return textResult(result.resumed, details);
				if (result.relayed)
					return textResult(
						`${result.sent.join(", ")} is not running: message #${result.id} goes through your parent ${result.relayed}, which resumes it with the message if it can. If not, you get a notice saying why.`,
						{ ...details, relayed: result.relayed },
					);
				if (params.interrupt)
					return textResult(
						`Interrupt queued for ${result.sent.join(", ")} as message #${result.id}: a busy subagent stops its current step within a second.`,
						details,
					);
				const departed = result.departed?.length ? ` Not sent to ${result.departed.join(", ")} (left the team).` : "";
				const recipients = result.sent.join(", ");
				// Told as it meets each recipient, so a sender knows an idle one will not act on an FYI alone, and which one is not answering.
				const delivery = result.delivery ?? {};
				const group = (status: string) => result.sent.filter((recipient) => delivery[recipient] === status);
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
						`Queued message #${result.id} for ${recipients} as a request: ${recipients} ${result.sent.length > 1 ? "are" : "is"} woken and must answer with replyTo ${result.id}.${departed}${[
							pace,
							stalled,
						]
							.filter(Boolean)
							.map((part) => ` ${part}`)
							.join("")}`,
						details,
					);
				const fates = [
					fate(
						group("wake"),
						"is woken: a turn starts if it is idle, otherwise it reads the message at its next step.",
						"are woken: a turn starts for each idle one, otherwise they read the message at their next steps.",
					),
					pace,
					fate(group("next-step"), "reads it at its next step.", "read it at their next steps."),
					fate(
						group("queued-quiet"),
						"is idle: it reads this on its next turn and will not act on it alone; replyRequired: true asks and wakes. wake: true starts it with no reply expected.",
						"are idle: they read this on their next turn and will not act on it alone; replyRequired: true asks and wakes. wake: true starts them with no reply expected.",
					),
					stalled,
				]
					.filter(Boolean)
					.join(" ");
				return textResult(
					[`Queued message #${result.id} for ${recipients} as an FYI (no reply requested).`, fates]
						.filter(Boolean)
						.join(" ") + departed,
					details,
				);
			},
			renderCall(args, theme, context) {
				// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
				const to = args.to === undefined ? "" : `→ ${String(args.to)}`;
				const reply = args.replyTo === undefined ? "" : `reply to #${String(args.replyTo)}`;
				const forward = args.forward === undefined ? "" : `forward #${String(args.forward)}`;
				// Queueing is instant: a millisecond count says nothing, so only a send that took a second or more shows its time.
				const slow = (context.durationMs ?? 0) >= 1_000;
				return toolHeader(
					theme,
					slow ? context : { ...context, durationMs: undefined },
					"Send",
					[forward, to, reply].filter(Boolean).join(" · "),
				);
			},
			renderResult(result, _options, theme, context) {
				const details: Record<string, unknown> = asRecord(result.details);
				const text = contentText(result.content);
				const sent = Array.isArray(details.to) ? details.to.map(String) : [];
				const departed =
					Array.isArray(details.departed) && details.departed.length
						? ` · not sent to ${details.departed.map(String).join(", ")}`
						: "";
				// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
				const message = isRecord(context.args) ? String(context.args.message ?? "") : "";
				// Collapsed, the first line of what was sent; the whole message shows when expanded.
				const first = context.expanded ? "" : clip(message.trimStart(), PREVIEW_CHARS);
				const preview = first ? ` · "${first}"` : "";
				const summary =
					typeof details.id === "number"
						? `Queued #${details.id}${sent.length > 1 ? ` to ${plural(sent.length, "agent")}` : ""}${preview}${departed}`
						: firstLine(text);
				return resultBlock(theme, context, {
					summary,
					body: context.isError ? text.split("\n").slice(1).join("\n") : message,
					max: context.isError ? 3 : 0,
					...timingOf(result.details),
				});
			},
		}),
	);
}
