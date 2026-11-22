import { Type, type Static } from "typebox";

export const TERMINAL_COMMAND_ROUTE = "/api/admin/session/commands";
const id = Type.String({ minLength: 1, maxLength: 128 });
export const TerminalCommandRequestSchema = Type.Union([
	Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("run"),
			id,
			sessionId: id,
			name: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^/\\s\\x00-\\x1f]+$" }),
			args: Type.String({ maxLength: 16000, pattern: "^[^\\x00-\\x1f\\x7f-\\x9f]*$" }),
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("status"), id, sessionId: id }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("input"),
			id,
			sessionId: id,
			dialog: id,
			sequence: Type.Integer({ minimum: 1 }),
			key: Type.Union([
				Type.Literal("up"),
				Type.Literal("down"),
				Type.Literal("left"),
				Type.Literal("right"),
				Type.Literal("enter"),
				Type.Literal("escape"),
				Type.Literal("tab"),
				Type.Literal("backspace"),
				Type.Literal("text"),
			]),
			text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, pattern: "^[^\\x00-\\x1f\\x7f-\\x9f]+$" })),
		},
		{ additionalProperties: false },
	),
]);
export type TerminalCommandRequest = Static<typeof TerminalCommandRequestSchema>;

export interface TerminalCommandDescription {
	name: string;
	description?: string;
	argumentHint?: string;
	aliases?: readonly string[];
}
export type TerminalCommandResult =
	| { sessionId: string; activeId?: string; commands: TerminalCommandDescription[] }
	| {
			id: string;
			name: string;
			phase: "running" | "dialog" | "done" | "failed";
			text: string;
			dialog?: string;
			sequence: number;
	  };
