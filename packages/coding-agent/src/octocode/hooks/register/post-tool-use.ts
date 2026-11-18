import { parsePatch } from "../../tool-input/codex-patch/patch.ts";
import type { FeatureSetup } from "../../../core/features/index.ts";
import { contentText } from "../../shared/util.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { commandsFor, hookCalls } from "../config/calls.ts";
import { ifFilter } from "../config/if-filter.ts";
import { CODEX_PATCH_NAMES } from "../patch.ts";
import { capContext } from "../runner.ts";
import type { Dispatch, HookSession } from "./types.ts";

/** PostToolUse: feedback from the hooks is appended to the tool result the model reads. */
export function registerPostToolUseHook(
	api: FeatureSetup,
	dispatch: Dispatch,
	session: HookSession,
	patches: Map<string, string>,
): void {
	api.bus.on("tool_result", async (event, ctx) => {
		const outcomes =
			event.toolName === "file" && isRecord(event.details) && Array.isArray(event.details.outcomes)
				? event.details.outcomes
				: undefined;
		// Codex: "For Bash, it also runs after commands that exit with a non-zero status"; a refused, aborted or timed-out call has no exit code.
		const exitedNonZero =
			event.toolName === "bash" &&
			isRecord(event.details) &&
			typeof event.details.exitCode === "number" &&
			event.details.exitCode !== 0;
		const patch = patches.get(event.toolCallId);
		patches.delete(event.toolCallId);
		const feedback: string[] = [];
		let replaceResult = false;
		let rejectNested = false;
		for (const protocol of ["octocode", "claude", "codex"] as const) {
			if (event.isError && protocol !== "claude" && !(protocol === "codex" && exitedNonZero)) continue;
			// Codex's patch observer only follows a fully successful patch, not a partially applied native batch.
			if (protocol === "codex" && outcomes?.some((outcome) => !isRecord(outcome) || outcome.ok !== true)) continue;
			const hookEvent = event.isError && protocol === "claude" ? "PostToolUseFailure" : "PostToolUse";
			if (
				protocol !== "codex" &&
				event.toolName === "file" &&
				typeof event.input.patch === "string" &&
				parsePatch(event.input.patch).hunks.some((h) => h.kind === "update")
			) {
				if (
					commandsFor(session.config, hookEvent, ["file", "Edit", "MultiEdit", "Write", "Delete"]).some(
						(h) => (h.protocol ?? "octocode") === protocol,
					)
				)
					feedback.push(
						`${protocol} ${hookEvent} hook unavailable: canonical Update/Move patches have no lossless per-query projection`,
					);
				continue;
			}
			const codexFile = protocol === "codex" && event.toolName === "file";
			if (
				codexFile &&
				!patch &&
				commandsFor(session.config, "PostToolUse", CODEX_PATCH_NAMES).some((hook) => hook.protocol === "codex")
			) {
				feedback.push(
					"Codex apply_patch PostToolUse hook unavailable: this file call has no lossless pre-call patch projection",
				);
			}
			const calls = codexFile
				? patch
					? [{ names: CODEX_PATCH_NAMES, tool_name: "apply_patch", tool_input: { command: patch } }]
					: []
				: hookCalls(event.toolName, event.input, ctx.cwd);
			for (const [index, call] of calls.entries()) {
				// A denied or failed file query cannot be reported as a successful mutation.
				if (!codexFile && outcomes && (!isRecord(outcomes[index]) || outcomes[index].ok !== true)) continue;
				const verdict = await dispatch(
					ctx,
					hookEvent,
					call.names,
					() => ({
						tool_use_id: event.toolCallId,
						tool_name: call.tool_name,
						pi_tool_name: event.toolName,
						tool_input: call.tool_input,
						...(hookEvent === "PostToolUseFailure"
							? { error: contentText(event.content), ...(ctx.signal?.aborted ? { is_interrupt: true } : {}) }
							: {
									// Codex documents a text `tool_response`; Claude and Octocode hooks get the result blocks.
									tool_response:
										protocol === "codex"
											? contentText(event.content)
											: { content: event.content, text: contentText(event.content) },
								}),
					}),
					ctx.signal,
					protocol,
					ifFilter(event.toolName, event.input, ctx.cwd, codexFile ? undefined : index),
				);
				feedback.push(...[verdict.block, verdict.context].filter((text): text is string => Boolean(text)));
				replaceResult ||= verdict.replaceResult === true;
				rejectNested ||= verdict.rejectNested === true;
			}
		}
		return feedback.length > 0
			? {
					content: [
						...(replaceResult ? [] : event.content),
						{
							type: "text" as const,
							text: `\n[${event.isError ? "PostToolUseFailure/PostToolUse" : "PostToolUse"} hook] ${capContext(feedback.join("\n\n"))}`,
						},
					],
					...(replaceResult ? { details: null } : {}),
					...(rejectNested && event.parentToolCallId ? { isError: true } : {}),
				}
			: undefined;
	});
}
