import { Box, Text } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/extensions/index.ts";
import { formatClock } from "../../shared/format.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../shared/messages.ts";
import { resultBlock, toolHeader } from "../../shared/render.ts";
import { contentText, firstLine, textResult } from "../../shared/util.ts";
import type { MailDetails } from "../model.ts";
import type { Team } from "../session.ts";
import { clip, plural } from "../../shared/render/text.ts";
import { timedTool, timingOf } from "../../shared/render/rows.ts";
import { isRecord } from "../../../utils/guards.ts";

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
				resultBlock(theme, { expanded: true }, { summary: "", body: String(entry?.text ?? ""), error: false }),
			);
		}
		return box;
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
				"Send steering, questions or evidence to a teammate or your session tree. Delivery is queued; unread departures are reported. A lingering child resumes on a message.",
			promptGuidelines: [
				"Send self-contained blockers, decisions or evidence that change the next step. Skip acknowledgements and completion pings; reports arrive automatically.",
			],
			parameters: Type.Object({
				to: Type.Optional(
					Type.String({
						description: 'Agent id, role, "parent" or "all"; omit with replyTo to answer its sender.',
					}),
				),
				message: Type.String(),
				replyRequired: Type.Optional(
					Type.Boolean({
						description: "true: a request you need answered; wakes an idle recipient. Default false: an FYI",
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
							"true: stop the recipient's current step and continue with this message; only the agent that started a subagent may. Default: deliver at its next step.",
					}),
				),
			}),
			async execute(_id, params, signal) {
				signal?.throwIfAborted();
				team.join();
				const result = await team.send(params.to, params.message, {
					...(signal ? { signal } : {}),
					...(params.replyRequired !== undefined ? { replyRequired: params.replyRequired } : {}),
					...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
					...(params.interrupt ? { interrupt: true } : {}),
				});
				if ("error" in result) throw new Error(result.error);
				if (result.resumed) return textResult(result.resumed, { to: result.sent });
				if (params.interrupt)
					return textResult(
						`Interrupt queued for ${result.sent.join(", ")} as message #${result.id}: a busy subagent stops its current step within a second.`,
						{ to: result.sent, id: result.id },
					);
				const departed = result.departed?.length ? ` Not sent to ${result.departed.join(", ")} (left the team).` : "";
				const recipients = result.sent.join(", ");
				const mode =
					params.replyRequired === true
						? `as a request: ${recipients} ${result.sent.length > 1 ? "are" : "is"} woken and must answer with replyTo ${result.id}`
						: "as an FYI (no reply requested)";
				return textResult(`Queued message #${result.id} for ${recipients} ${mode}.${departed}`, {
					to: result.sent,
					id: result.id,
					...(result.departed?.length ? { departed: result.departed } : {}),
				});
			},
			renderCall(args, theme, context) {
				const to = args.to === undefined ? "" : `→ ${String(args.to)}`;
				const reply = args.replyTo === undefined ? "" : `reply to #${String(args.replyTo)}`;
				// Queueing is instant: a millisecond count says nothing, so only a send that took a second or more shows its time.
				const slow = (context.durationMs ?? 0) >= 1_000;
				return toolHeader(
					theme,
					slow ? context : { ...context, durationMs: undefined },
					"Send",
					[to, reply].filter(Boolean).join(" · "),
				);
			},
			renderResult(result, _options, theme, context) {
				const details: Record<string, unknown> = isRecord(result.details) ? result.details : {};
				const text = contentText(result.content);
				const sent = Array.isArray(details.to) ? details.to.map(String) : [];
				const departed =
					Array.isArray(details.departed) && details.departed.length
						? ` · not sent to ${details.departed.map(String).join(", ")}`
						: "";
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
