import type { ExtensionContext } from "../../../core/features/index.ts";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { HOOK_EVENTS, type HookEvent } from "../catalog.ts";
import { commandsFor, hookCalls } from "../config/calls.ts";
import { hookLabel } from "../config.ts";
import type { HookVerdict } from "../contracts.ts";
import { clipText } from "../../shared/util.ts";
import type { Dispatch, HookSession } from "./types.ts";

const TOOL_EVENTS: readonly HookEvent[] = ["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"];
export const TEST_USAGE =
	'Usage: /harness hooks test <Event> [<tool or matcher> [<json>]] runs the configured hooks on a sample event. A tool event takes the tool name and its input as JSON, e.g. test PreToolUse bash {"command":"ls"}; other events take the matcher value and extra input fields as JSON. Hooks really run: a hook with side effects has them.';

/** Runs the hooks configured for `event` once on a sample input and says what each answer did; the model never sees it. */
export async function testRunHooks(
	dispatch: Dispatch,
	session: HookSession,
	ctx: ExtensionContext,
	words: readonly string[],
): Promise<string> {
	const [name, target, ...rest] = words;
	const event = HOOK_EVENTS.find((candidate) => candidate === name);
	if (!event) return `${name ? `Unknown hook event ${name}. ` : ""}${TEST_USAGE}`;
	let extra: Record<string, unknown> = {};
	if (rest.length > 0) {
		try {
			const parsed: unknown = JSON.parse(rest.join(" "));
			if (!isRecord(parsed)) return `The sample input must be a JSON object. ${TEST_USAGE}`;
			extra = parsed;
		} catch (error) {
			return `The sample input is not valid JSON (${errorMessage(error)}). ${TEST_USAGE}`;
		}
	}
	let names: string[] = target ? [target] : [];
	let input: Record<string, unknown> = extra;
	if (TOOL_EVENTS.includes(event)) {
		const [call] = hookCalls(target ?? "bash", extra, ctx.cwd);
		if (!call) return `No sample call could be built for ${target ?? "bash"}. ${TEST_USAGE}`;
		names = call.names;
		input = {
			tool_use_id: "hook-test",
			tool_name: call.tool_name,
			tool_input: call.tool_input,
			...(event === "PostToolUse" ? { tool_response: { content: [], text: "" } } : {}),
			...(event === "PostToolUseFailure" ? { error: "sample failure" } : {}),
		};
	}
	const matched = commandsFor(session.config, event, names);
	if (matched.length === 0)
		return `No ${event} hook matches ${names.join(" / ") || "an empty matcher"}; /harness hooks lists what is loaded.`;
	const verdict: HookVerdict = await dispatch(ctx, event, names, () => input, ctx.signal);
	const answers = [
		verdict.block && `block: ${verdict.block}`,
		verdict.ask && `ask: ${verdict.ask}`,
		verdict.permissionDecision && `permission: ${verdict.permissionDecision}`,
		verdict.context && `context: ${verdict.context}`,
		verdict.updatedInput && `input rewrite: ${JSON.stringify(verdict.updatedInput)}`,
		verdict.systemMessage && `message: ${verdict.systemMessage}`,
		verdict.error && `error: ${verdict.error}`,
		verdict.stop && "stop requested",
	].filter((line): line is string => typeof line === "string");
	return [
		`${event} on ${names.join(" / ") || "(no matcher)"}: ${matched.length} hook${matched.length === 1 ? "" : "s"} ran`,
		...matched.map((hook) => `  ${clipText(hookLabel(hook), 100)}`),
		answers.length > 0 ? "Answer:" : "Answer: none (the hook allowed or observed).",
		...answers.map((line) => `  ${clipText(line, 400)}`),
	].join("\n");
}
