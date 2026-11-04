import { StringEnum } from "@octocodeai/octocode-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { MAX_HANDOFF_REFERENCES } from "../shared/references.ts";

/** The range of a prompt's `timeoutMs`: checked when the call is parsed and again by the backend that runs it. */
export const PROMPT_TIMEOUT_MS = { min: 1000, max: 600_000 } as const;
export const promptTimeoutValid = (ms: number): boolean =>
	Number.isInteger(ms) && ms >= PROMPT_TIMEOUT_MS.min && ms <= PROMPT_TIMEOUT_MS.max;

export const ExternalParamsSchema = Type.Object(
	{
		action: StringEnum(["list", "connect", "prompt", "cancel", "disconnect"] as const, {
			description:
				"list also shows running instances and installed ACP agents; prompt waits for the reply; cancel stops the prompt in flight",
		}),
		id: Type.Optional(Type.String({ description: "prompt/cancel/disconnect: connection id" })),
		transport: Type.Optional(
			StringEnum(["acp", "octocode"] as const, {
				description: "connect: acp (agent command) or octocode (running instance)",
			}),
		),
		vendor: Type.Optional(Type.String({ description: "connect acp: the agent's real vendor" })),
		command: Type.Optional(Type.String({ description: "connect acp: executable" })),
		args: Type.Optional(Type.Array(Type.String())),
		instanceId: Type.Optional(Type.String({ description: "connect octocode: instance id or process name from list" })),
		cwd: Type.Optional(Type.String({ description: "connect: workspace (octocode: defaults to the instance's)" })),
		sessionId: Type.Optional(Type.String({ description: "connect acp: session to resume" })),
		model: Type.Optional(Type.String({ description: "connect acp: model option" })),
		text: Type.Optional(Type.String({ description: "prompt: the whole message; the peer sees nothing else" })),
		// No `maxItems`: schemas carry shape only; `resolveReferences` refuses more than MAX_HANDOFF_REFERENCES at runtime.
		refs: Type.Optional(
			Type.Array(Type.String(), {
				description: "prompt: msg#N or report:<agent-id>, appended to text before approval",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Integer({
				description: `connect acp, prompt: ms, ${PROMPT_TIMEOUT_MS.min} to ${PROMPT_TIMEOUT_MS.max}`,
			}),
		),
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
	if (input.model && input.model.length > 200) throw new Error("model must have at most 200 characters.");
	if (input.timeoutMs !== undefined && !promptTimeoutValid(input.timeoutMs))
		throw new Error(`timeoutMs must be from ${PROMPT_TIMEOUT_MS.min} to ${PROMPT_TIMEOUT_MS.max}.`);
	const fields =
		input.action === "list"
			? ["action"]
			: input.action === "connect"
				? input.transport === "octocode"
					? ["action", "id", "transport", "instanceId", "cwd"]
					: ["action", "id", "transport", "vendor", "command", "args", "cwd", "sessionId", "model", "timeoutMs"]
				: input.action === "prompt"
					? ["action", "id", "text", "refs", "timeoutMs"]
					: ["action", "id"];
	const unused = Object.keys(input).filter((key) => !fields.includes(key));
	if (unused.length) throw new Error(`${input.action} does not accept: ${unused.join(", ")}.`);
	if (input.action === "connect") {
		if (!input.transport) throw new Error("connect requires transport.");
		if (input.transport === "acp" && (!input.command || !input.vendor))
			throw new Error("ACP connect requires command and the real host vendor.");
		if (input.transport === "octocode" && !input.instanceId)
			throw new Error("Octocode connect requires instanceId: an instance id or process name from list.");
	} else if (input.action !== "list" && !input.id) throw new Error(`${input.action} requires id.`);
	if (input.action === "prompt" && !input.text) throw new Error("prompt requires text.");
	if (input.refs) {
		if (input.refs.some((ref) => !ref.trim())) throw new Error("refs entries must be non-empty.");
		if (input.refs.length > MAX_HANDOFF_REFERENCES)
			throw new Error(`refs: at most ${MAX_HANDOFF_REFERENCES} references per prompt.`);
	}
	return input;
}

export interface ExternalInfo {
	id: string;
	transport: NonNullable<ExternalParams["transport"]>;
	vendor: string;
	cwd: string;
	sessionId: string;
	busy: boolean;
	/** The model the external agent reports it runs on, when its protocol says. */
	model?: string;
}
