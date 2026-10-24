import { StringEnum } from "@octocodeai/octocode-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

/** The range of a prompt's `timeoutMs`: checked when the call is parsed and again by the backend that runs it. */
export const PROMPT_TIMEOUT_MS = { min: 1000, max: 600_000 } as const;
export const promptTimeoutValid = (ms: number): boolean =>
	Number.isInteger(ms) && ms >= PROMPT_TIMEOUT_MS.min && ms <= PROMPT_TIMEOUT_MS.max;

export const ExternalParamsSchema = Type.Object(
	{
		action: StringEnum(["list", "connect", "prompt", "cancel", "disconnect"] as const),
		id: Type.Optional(Type.String()),
		transport: Type.Optional(StringEnum(["acp", "octocode"] as const)),
		vendor: Type.Optional(Type.String()),
		command: Type.Optional(Type.String()),
		args: Type.Optional(Type.Array(Type.String())),
		instanceId: Type.Optional(Type.String()),
		cwd: Type.Optional(Type.String()),
		sessionId: Type.Optional(Type.String()),
		text: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Integer()),
	},
	{ additionalProperties: false },
);

export type ExternalParams = Static<typeof ExternalParamsSchema>;

export function parseExternalParams(value: unknown): ExternalParams {
	if (!Check(ExternalParamsSchema, value))
		throw new Error('Invalid agent external input; use the schema of `agent` type "external".');
	const input = value;
	for (const [name, field] of Object.entries(input)) {
		if (typeof field === "string" && !field.trim()) throw new Error(`${name} must be non-empty.`);
	}
	if (input.vendor && input.vendor.length > 64) throw new Error("vendor must have at most 64 characters.");
	if (input.timeoutMs !== undefined && !promptTimeoutValid(input.timeoutMs))
		throw new Error(`timeoutMs must be from ${PROMPT_TIMEOUT_MS.min} to ${PROMPT_TIMEOUT_MS.max}.`);
	const fields =
		input.action === "list"
			? ["action"]
			: input.action === "connect"
				? input.transport === "octocode"
					? ["action", "id", "transport", "instanceId", "cwd"]
					: ["action", "id", "transport", "vendor", "command", "args", "cwd", "sessionId", "timeoutMs"]
				: input.action === "prompt"
					? ["action", "id", "text", "timeoutMs"]
					: ["action", "id"];
	const unused = Object.keys(input).filter((key) => !fields.includes(key));
	if (unused.length) throw new Error(`${input.action} does not accept: ${unused.join(", ")}.`);
	if (input.action === "connect") {
		if (!input.transport) throw new Error("connect requires transport.");
		if (input.transport === "acp" && (!input.command || !input.vendor))
			throw new Error("ACP connect requires command and the real host vendor.");
		if (input.transport === "octocode" && !input.instanceId)
			throw new Error("Octocode connect requires an exact discovered instanceId.");
	} else if (input.action !== "list" && !input.id) throw new Error(`${input.action} requires id.`);
	if (input.action === "prompt" && !input.text) throw new Error("prompt requires text.");
	return input;
}

export interface ExternalInfo {
	id: string;
	transport: NonNullable<ExternalParams["transport"]>;
	vendor: string;
	cwd: string;
	sessionId: string;
	busy: boolean;
}

export interface ExternalReply {
	text: string;
	stopReason?: string;
	updates?: unknown[];
}

export interface ExternalBackend {
	readonly sessionId: string;
	readonly cwd: string;
	/** Explicit liveness lets a transport retain a connection after an uncertain prompt failure. */
	readonly isClosed?: boolean;
	prompt(text: string, options: { timeoutMs: number; signal?: AbortSignal; key?: string }): Promise<ExternalReply>;
	cancel(): Promise<void>;
	close(): Promise<void>;
}
