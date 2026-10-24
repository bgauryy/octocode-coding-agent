import { rewriteClaudeBash } from "../../shared/claude-bash.ts";
import { parsePatch } from "../../shared/codex-patch/patch.ts";
import { validateFileInput } from "../../shared/file-input.ts";
import { rewriteCodexCommand } from "../rewrite.ts";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import type { ExtensionAPI } from "../../../core/extensions/index.ts";
import { rewriteFileQuery } from "../../shared/claude-file.ts";
import { errorMessage } from "../../../utils/guards.ts";
import { commandsFor, hookCalls } from "../config/calls.ts";
import { CODEX_PATCH_NAMES, projectCodexPatch, rewriteCodexPatch } from "../patch.ts";
import type { HookProtocol } from "../profiles.ts";
import { capContext } from "../runner.ts";
import { CONTEXT_TYPE, type Dispatch, type HookSession, type HooksView } from "./types.ts";

/**
 * Native and Claude file hooks run once per query. Codex receives one whole-batch apply_patch call.
 * All pre-call decisions run in parallel; any denial blocks the native batch.
 */
export const preToolUseGate =
	(pi: ExtensionAPI, dispatch: Dispatch, session: HookSession, patches: Map<string, string>): HooksView["preToolUse"] =>
	async (event, ctx) => {
		if (event.toolName === "file") {
			try {
				validateFileInput(event.input);
			} catch (error) {
				return { block: true, reason: errorMessage(error) };
			}
		}
		if (event.toolName === "file" && typeof event.input.patch === "string") {
			try {
				const patch = parsePatch(event.input.patch);
				if (
					patch.hunks.some((h) => h.kind === "update") &&
					commandsFor(session.config, "PreToolUse", ["file", "Edit", "MultiEdit", "Write", "Delete"]).some(
						(h) => h.protocol !== "codex",
					)
				) {
					return {
						block: true,
						reason:
							"Canonical Update/Move patches cannot be represented losslessly to matching native or Claude PreToolUse hooks; use native file queries",
					};
				}
			} catch (error) {
				return { block: true, reason: errorMessage(error) };
			}
		}
		const calls = hookCalls(event.toolName, event.input, ctx.cwd);
		const dispatches =
			event.toolName === "file"
				? calls.flatMap((call, index) =>
						(["octocode", "claude"] as const).map((protocol) => ({ ...call, index, protocol })),
					)
				: calls.map((call, index) => ({ ...call, index, protocol: undefined as HookProtocol | undefined }));
		const codexGate =
			event.toolName === "file" &&
			commandsFor(session.config, "PreToolUse", CODEX_PATCH_NAMES).some((hook) => hook.protocol === "codex");
		const codexPost =
			event.toolName === "file" &&
			commandsFor(session.config, "PostToolUse", CODEX_PATCH_NAMES).some((hook) => hook.protocol === "codex");
		if (codexGate || codexPost) {
			try {
				const command = projectCodexPatch(event.input);
				patches.set(event.toolCallId, command);
				if (codexGate)
					dispatches.push({
						names: CODEX_PATCH_NAMES,
						tool_name: "apply_patch",
						tool_input: { command },
						index: -1,
						protocol: "codex",
					});
			} catch (error) {
				if (codexGate)
					return { block: true, reason: `Cannot run matching Codex apply_patch hook: ${errorMessage(error)}` };
			}
		}
		const verdicts = await Promise.all(
			dispatches.map((call) =>
				dispatch(
					ctx,
					"PreToolUse",
					call.names,
					() => ({
						tool_use_id: event.toolCallId,
						tool_name: call.tool_name,
						pi_tool_name: event.toolName,
						tool_input: call.tool_input,
					}),
					ctx.signal,
					call.protocol,
				),
			),
		);
		const block = verdicts.find((verdict) => verdict.block)?.block;
		if (block) return { block: true, reason: `Blocked by a PreToolUse hook: ${block}` };
		const rewrites = verdicts.flatMap((verdict) => (verdict.updatedInput ? [verdict.updatedInput] : []));
		let rewritten = false;
		if (rewrites.length) {
			if (
				event.origin === "user" ||
				["read", "edit", "write"].includes(event.toolName) ||
				(event.toolName !== "file" && calls.length !== 1)
			)
				return {
					block: true,
					reason: "Input rewrite requires an unavailable reverse adapter for this tool; call not executed",
				};
			const definition = pi.getAllTools().find((tool) => tool.name === event.toolName);
			if (!definition) return { block: true, reason: "Cannot validate rewritten input for an unknown tool" };
			try {
				let replacement: Record<string, unknown> = rewrites[0];
				if (
					event.toolName === "bash" &&
					verdicts.find((verdict) => verdict.updatedInput)?.updatedInputProtocol === "codex"
				)
					replacement = rewriteCodexCommand(event.input, rewrites[0]);
				if (
					event.toolName === "bash" &&
					verdicts.find((verdict) => verdict.updatedInput)?.updatedInputProtocol === "claude"
				)
					replacement = rewriteClaudeBash(event.input, rewrites[0]);
				if (event.toolName === "file") {
					const codexRewrite = verdicts.find(
						(verdict) => verdict.updatedInputProtocol === "codex" && verdict.updatedInput,
					)?.updatedInput;
					if (
						codexRewrite &&
						verdicts.some((verdict) => verdict.updatedInput && verdict.updatedInputProtocol !== "codex")
					)
						throw new Error("Conflicting source-profile file rewrites; call not executed");
					replacement = codexRewrite ? rewriteCodexPatch(event.input, codexRewrite) : structuredClone(event.input);
					if (!codexRewrite)
						for (const [index, verdict] of verdicts.entries())
							if (verdict.updatedInput) {
								if (verdict.updatedInputProtocol !== "claude") throw new Error("Unsupported file rewrite profile");
								replacement = rewriteFileQuery(replacement, dispatches[index].index, verdict.updatedInput);
							}
					if (codexGate || codexPost) {
						try {
							patches.set(
								event.toolCallId,
								// rewriteCodexPatch above refused a rewrite whose command is not a string.
								codexRewrite ? (codexRewrite.command as string) : projectCodexPatch(replacement),
							);
						} catch (error) {
							patches.delete(event.toolCallId);
							if (codexGate) throw error;
						}
					}
				}
				const validated = validateToolArguments(definition, {
					type: "toolCall",
					id: event.toolCallId,
					name: event.toolName,
					arguments: replacement as Parameters<typeof validateToolArguments>[1]["arguments"],
				});
				for (const key of Object.keys(event.input)) delete (event.input as Record<string, unknown>)[key];
				Object.assign(event.input, validated);
				rewritten = true;
			} catch (error) {
				return { block: true, reason: `Invalid hook input rewrite: ${errorMessage(error)}` };
			}
		}
		const context = verdicts
			.map((verdict) => verdict.context)
			.filter(Boolean)
			.join("\n\n");
		if (context && !ctx.signal?.aborted) {
			await pi.sendMessage(
				{ customType: CONTEXT_TYPE, content: capContext(`Context from PreToolUse hooks:\n${context}`), display: false },
				{ triggerTurn: false },
			);
		}
		const ask = verdicts
			.map((verdict) => verdict.ask)
			.filter(Boolean)
			.join("\n\n");
		return ask || rewritten
			? { ...(ask ? { ask: capContext(ask) } : {}), ...(rewritten ? { rewritten: true } : {}) }
			: undefined;
	};
