import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { type Static, Type } from "typebox";
import { getShellEnv } from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { type BashOperations, createLocalBashOperations } from "./bash/local-operations.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

export { type BashOperations, createLocalBashOperations, createLocalShellOperations } from "./bash/local-operations.ts";

/** Output limit of `structuredContent.output`, which programmatic callers such as programmatic tool callers receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect OCTOCODE_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as programmatic tool callers. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

/**
 * The environment a bash command runs with: the shell environment, with the OCTOCODE_* session variables set from `ctx`
 * and never inherited from the parent process.
 */
export function bashSessionEnv(ctx: ExtensionContext | undefined): NodeJS.ProcessEnv {
	const env = { ...getShellEnv() };
	delete env.OCTOCODE_SESSION_ID;
	delete env.OCTOCODE_SESSION_FILE;
	delete env.OCTOCODE_PROVIDER;
	delete env.OCTOCODE_MODEL;
	delete env.OCTOCODE_REASONING_LEVEL;
	if (!ctx) return env;
	env.OCTOCODE_SESSION_ID = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.OCTOCODE_SESSION_FILE = sessionFile;
	if (ctx.model) {
		env.OCTOCODE_PROVIDER = ctx.model.provider;
		env.OCTOCODE_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.OCTOCODE_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = bashSessionEnv(exposeSessionEnvironment ? ctx : undefined);
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Octocode session metadata as OCTOCODE_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first), keeping the first and last lines. A line redrawn with carriage returns (a progress bar) shows only its final state. If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const headLines = truncation.headLines ?? 0;
					const tailLines = truncation.outputLines - headLines;
					const endLine = truncation.totalLines;
					const limit = truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
					const shown =
						headLines > 0
							? `first ${headLines} and last ${tailLines} lines`
							: `lines ${truncation.totalLines - truncation.outputLines + 1}-${endLine}`;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						const partSize = formatSize(truncation.outputBytes - (truncation.headBytes ?? 0));
						text += `\n\n[Showing ${headLines > 0 ? `first ${headLines} lines and ` : ""}last ${partSize} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing ${shown} of ${truncation.totalLines}${limit}. Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const startedAt = performance.now();

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode === null) {
					throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
				}
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath ? { full_output_path: snapshot.fullOutputPath } : {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
				};
				if (exitCode !== 0) {
					return {
						content: [{ type: "text", text: appendStatus(outputText, `Command exited with code ${exitCode}`) }],
						details,
						structuredContent,
						isError: true,
					};
				}
				return { content: [{ type: "text", text: outputText }], details, structuredContent };
			} finally {
				clearUpdateTimer();
			}
		},
		...createShellRenderers(config.prompt),
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "octocode-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
