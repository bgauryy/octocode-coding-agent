import { renderPrompt } from "../../../core/prompt-template.ts";
import { rewriteClaudeBash } from "../../tool-input/claude-bash.ts";
import { parsePatch } from "../../tool-input/codex-patch/patch.ts";
import { validateFileInput } from "../../tool-input/file-input.ts";
import { rewriteCodexCommand } from "../rewrite.ts";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import type { FeatureSetup } from "../../../core/features/index.ts";
import { rewriteFileQuery } from "../../tool-input/claude-file.ts";
import { say } from "../../shared/commands.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { commandsFor, hookCalls } from "../config/calls.ts";
import { ifFilter } from "../config/if-filter.ts";
import { CODEX_PATCH_NAMES, type EditProjector, projectCodexPatch, rewriteCodexPatch } from "../patch.ts";
import type { HookProtocol } from "../catalog.ts";
import { capContext } from "../runner.ts";
import { firstRewrite } from "../verdicts.ts";
import { CONTEXT_TYPE, type Dispatch, type HookSession, type HooksView } from "./types.ts";

/**
 * Native and Claude file hooks run once per query. Codex receives one whole-batch apply_patch call.
 * All pre-call decisions run in parallel; any denial blocks the native batch.
 *
 * A hook that cannot see a call losslessly (a canonical patch for a per-query hook, a native edit for an apply_patch
 * hook without a verified read) fails open like a crashed hook: the call runs without it, with a warning that names
 * what was skipped. Only a hook that opted into `failClosed` denies the call instead.
 */
/** Whether a matching Codex apply_patch PreToolUse hook asked to deny calls it cannot judge. */
const codexFailsClosed = (session: HookSession): boolean =>
	commandsFor(session.config, "PreToolUse", CODEX_PATCH_NAMES).some(
		(hook) => hook.protocol === "codex" && hook.failClosed,
	);

export const preToolUseGate =
	(
		api: FeatureSetup,
		dispatch: Dispatch,
		session: HookSession,
		patches: Map<string, string>,
		projectEdit?: EditProjector,
	): HooksView["preToolUse"] =>
	async (event, ctx) => {
		const snapshots = projectEdit ? { projectEdit, cwd: ctx.cwd } : undefined;
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
				const perQuery = commandsFor(session.config, "PreToolUse", [
					"file",
					"Edit",
					"MultiEdit",
					"Write",
					"Delete",
				]).filter((h) => h.protocol !== "codex");
				if (patch.hunks.some((h) => h.kind === "update") && perQuery.length) {
					const message =
						"Canonical Update/Move patches cannot be represented losslessly to matching native or Claude PreToolUse hooks";
					if (perQuery.some((h) => h.failClosed)) return { block: true, reason: `${message}; use native file queries` };
					say(ctx, `${message}; they were skipped for this call.`, "warning");
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
				const command = projectCodexPatch(event.input, snapshots);
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
				const reason = `Cannot run matching Codex apply_patch hook: ${errorMessage(error)}`;
				if (codexGate && codexFailsClosed(session)) return { block: true, reason };
				say(ctx, `${reason}; the hook was skipped for this call.`, "warning");
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
					ifFilter(event.toolName, event.input, ctx.cwd, call.index >= 0 ? call.index : undefined),
				),
			),
		);
		const block = verdicts.find((verdict) => verdict.block)?.block;
		if (block) return { block: true, reason: `Blocked by a PreToolUse hook: ${block}` };
		const rewrite = firstRewrite(verdicts);
		let rewritten = false;
		if (rewrite?.updatedInput) {
			if (event.origin === "user" || (event.toolName !== "file" && calls.length !== 1))
				return {
					block: true,
					reason: "Input rewrite requires an unavailable reverse adapter for this tool; call not executed",
				};
			const definition = api.tools.getAll().find((tool) => tool.name === event.toolName);
			if (!definition) return { block: true, reason: "Cannot validate rewritten input for an unknown tool" };
			try {
				let replacement: Record<string, unknown> = rewrite.updatedInput;
				if (event.toolName === "bash" && rewrite.updatedInputProtocol === "codex")
					replacement = rewriteCodexCommand(event.input, rewrite.updatedInput);
				if (event.toolName === "bash" && rewrite.updatedInputProtocol === "claude")
					replacement = rewriteClaudeBash(event.input, rewrite.updatedInput);
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
								codexRewrite ? (codexRewrite.command as string) : projectCodexPatch(replacement, snapshots),
							);
						} catch (error) {
							patches.delete(event.toolCallId);
							if (codexGate && codexFailsClosed(session)) throw error;
							say(ctx, `Codex apply_patch hooks skipped for the rewritten call: ${errorMessage(error)}`, "warning");
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
			await api.session.sendMessage(
				{
					customType: CONTEXT_TYPE,
					content: capContext(renderPrompt("hooks/context.md", { source: "PreToolUse", text: context })),
					display: false,
				},
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
