import { Box, Text } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../core/extensions/index.ts";
import { formatClock } from "../../shared/format.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../shared/messages.ts";
import { clip, plural, resultBlock, timedTool, timingOf, toolHeader } from "../../shared/render.ts";
import { contentText, firstLine, isRecord, textResult } from "../../shared/util.ts";
import type { MailDetails } from "../model.ts";
import { senderLabel } from "../routing.ts";
import type { Team } from "../session.ts";

/** Shows team mail in the conversation. */
export function registerMessageRenderer(pi: ExtensionAPI): void {
	// Agent messages are shown in full, collapsed or not: they are short (a long one arrives as its start plus a file path) and the user reads them.
	pi.registerMessageRenderer(INTERNAL_MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const mail = (message.details as Partial<MailDetails> | undefined)?.messages;
		const box = new Box(outputPad ?? 1, 0);
		// Details are another process's data: anything but a batch shows the text the model got.
		const entries = Array.isArray(mail)
			? mail
			: [{ from: "agent", text: typeof message.content === "string" ? message.content : "", at: Date.now() }];
		for (const entry of entries) {
			const sender = entry?.sender;
			const from = clip(`${String(entry?.from ?? "agent")}${sender ? ` (${senderLabel(sender)})` : ""}`, 100);
			const kind = entry?.replyRequired ? " · reply requested" : "";
			box.addChild(
				new Text(
					`${theme.fg("accent", "✉")} ${theme.fg("toolTitle", theme.bold(`from ${from}`))} ${theme.fg("dim", `· ${formatClock(entry?.at ?? Date.now())}${kind}`)}`,
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
	pi: ExtensionAPI,
	team: Team,
	registerTool: ExtensionAPI["registerTool"] = (tool) => pi.registerTool(tool),
): void {
	registerTool(
		timedTool({
			name: "sendMessage",
			label: "Send message",
			description:
				"Send steering, questions or evidence to a teammate or your session tree. Delivery is queued; unread departures are reported. A lingering child resumes on a message; otherwise start a new task. Long messages include a file path to the full text.",
			promptSnippet: "Message a subagent or teammate",
			promptGuidelines: [
				"Send self-contained blockers, decisions or evidence that change the next step. Skip acknowledgements and completion pings; reports arrive automatically.",
			],
			parameters: Type.Object({
				to: Type.Optional(
					Type.String({
						description: 'Agent id, role, "parent" or "all" (session tree). replyTo alone targets the original sender.',
					}),
				),
				message: Type.String({ description: "The message text" }),
				replyRequired: Type.Optional(
					Type.Boolean({
						description:
							"true: a request (a question or task you need answered); wakes an idle recipient. false (the default): an FYI, no reply needed",
					}),
				),
				replyTo: Type.Optional(
					Type.Integer({
						description: "Message number to answer; no to needed. Wakes the asker.",
					}),
				),
				interrupt: Type.Optional(
					Type.Boolean({
						description:
							"true: cancel your child's current step and continue with this message. Default false: deliver at its next step.",
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
				return toolHeader(theme, context, "Send", [to, reply].filter(Boolean).join(" · "));
			},
			renderResult(result, _options, theme, context) {
				const details: Record<string, unknown> = isRecord(result.details) ? result.details : {};
				const text = contentText(result.content);
				const sent = Array.isArray(details.to) ? details.to.map(String) : [];
				const departed =
					Array.isArray(details.departed) && details.departed.length
						? ` · not sent to ${details.departed.map(String).join(", ")}`
						: "";
				const summary =
					typeof details.id === "number"
						? `Queued #${details.id}${sent.length > 1 ? ` to ${plural(sent.length, "agent")}` : ""}${departed}`
						: firstLine(text);
				// The message itself is the model's own words: shown only when expanded.
				const message = isRecord(context.args) ? String(context.args.message ?? "") : "";
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
