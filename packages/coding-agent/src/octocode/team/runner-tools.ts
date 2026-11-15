import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ServedCall, ServedTool } from "../../../../mcp/src/api.ts";
import type { RunnerMember } from "./runner-member.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { INBOX_BATCH_SIZE } from "./store/limits.ts";

const parameters = Type.Object(
	{
		action: Type.Union([Type.Literal("list"), Type.Literal("inbox"), Type.Literal("send")]),
		ack: Type.Optional(
			Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), { maxItems: INBOX_BATCH_SIZE }),
		),
		to: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		replyTo: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
		replyRequired: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const runnerTeamTool = {
	name: "team",
	description: renderInstruction("tools/agent/runner-tool.md"),
	inputSchema: { ...parameters },
} satisfies ServedTool;

export async function callRunnerTeam(member: RunnerMember, call: ServedCall) {
	const args = call.arguments;
	if (!Value.Check(parameters, args))
		throw new Error("Invalid team call: use only the declared fields and their JSON types.");
	const allowed =
		args.action === "send"
			? ["action", "to", "message", "replyTo", "replyRequired"]
			: args.action === "inbox"
				? ["action", "ack"]
				: ["action"];
	if (Object.keys(args).some((key) => !allowed.includes(key)))
		throw new Error(`Only ${allowed.join(", ")} apply to ${args.action}.`);
	let result: unknown;
	if (args.action === "list") result = member.list(call.signal);
	else if (args.action === "inbox") result = member.inbox(args.ack ?? [], call.signal);
	else {
		if (typeof args.message !== "string" || !args.message.trim()) throw new Error("Give the message to send.");
		result = await member.send(
			args.to,
			args.message,
			{ replyTo: args.replyTo, replyRequired: args.replyRequired },
			call.signal,
		);
	}
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result) }],
		...(typeof result === "object" && result !== null && "error" in result ? { isError: true } : {}),
	};
}
