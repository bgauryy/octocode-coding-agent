import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { type Static, Type } from "typebox";
import { getShellEnv } from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { type BashOperations, createLocalBashOperations } from "./bash/local-operations.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { BASH_MAX_BYTES, BASH_MAX_LINES, bashBudget } from "./bash/budget.ts";
import { type BashEnd, formatBashHeader } from "./bash/header.ts";
import { BashExecutionError, type BashToolDetails } from "./bash/outcome.ts";

export { type BashOperations, createLocalBashOperations } from "./bash/local-operations.ts";
export { type BashToolDetails } from "./bash/outcome.ts";

/** Output limit of `structuredContent.output`, which programmatic callers such as programmatic tool callers receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

/** The per-call output budget; the native `bash` tool declares the same parameter. */
export const maxOutputTokensParameter = Type.Optional(
	Type.Number({
		description: "Output token budget for this result (about 4 bytes each, at least 100)",
	}),
);

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	maxOutputTokens: maxOutputTokensParameter,
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: [],
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
	total_lines: Type.Number(),
	total_bytes: Type.Number(),
});

type BashToolOutput = Static<typeof bashOutputSchema>;

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
	/** Most bytes of a result that reach the model (the `bashOutputMaxBytes` setting). Default: 20 KB */
	maxOutputBytes?: number;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

function createShellToolDefinition(
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
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Every result starts with a line giving the exit code, time and output size. Output over the budget (${BASH_MAX_BYTES / 1000}KB or ${BASH_MAX_LINES} lines by default; maxOutputTokens lowers it) keeps the first 20% and last 80%, plus up to 20 error lines from the middle with their line numbers, and is saved in full to a file named in that line. A line redrawn with carriage returns (a progress bar) shows only its final state, and a run of identical lines shows once with a count. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout, maxOutputTokens }: { command: string; timeout?: number; maxOutputTokens?: number },
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
			const output = new OutputAccumulator({
				...bashBudget(options?.maxOutputBytes, maxOutputTokens),
				tempFilePrefix: config.tempFilePrefix,
				smartTrim: true,
			});
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
						output: snapshot.content,
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

			/** The model-facing output without a header, and the facts the renderers show. */
			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>) => {
				const details: BashToolDetails = { output: snapshot.content };
				if (snapshot.truncation.truncated) {
					Object.assign(details, { truncation: snapshot.truncation, fullOutputPath: snapshot.fullOutputPath });
				}
				return { body: snapshot.content, details };
			};

			/** The result text: the header line, then the output when there is any. */
			const withHeader = (snapshot: Awaited<ReturnType<typeof finishOutput>>, body: string, end: BashEnd) => {
				const header = formatBashHeader(end, {
					totalLines: snapshot.truncation.totalLines,
					totalBytes: snapshot.truncation.totalBytes,
					truncation: snapshot.truncation,
					fullOutputPath: snapshot.fullOutputPath,
					lastLineBytes: output.getLastLineBytes(),
				});
				return body ? `${header}\n${body}` : header;
			};

			const startedAt = performance.now();
			const elapsedSeconds = () => Math.round((performance.now() - startedAt) / 100) / 10;

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
					const { body, details } = formatOutput(snapshot);
					if (err instanceof Error && err.message === "aborted") {
						throw new BashExecutionError(
							withHeader(snapshot, body, { kind: "aborted", seconds: elapsedSeconds() }),
							{ ...details, termination: "aborted" },
							body,
						);
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new BashExecutionError(
							withHeader(snapshot, body, { kind: "timeout", seconds: Number(timeoutSecs) }),
							{
								...details,
								termination: "timeout",
								timeoutSeconds: Number(timeoutSecs),
							},
							body,
						);
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { body, details } = formatOutput(snapshot);
				details.exitCode = exitCode;
				const wallTimeSeconds = elapsedSeconds();
				if (exitCode === null) {
					throw new BashExecutionError(
						withHeader(snapshot, body, { kind: "terminated", seconds: wallTimeSeconds }),
						{
							...details,
							termination: "terminated",
						},
						body,
					);
				}
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath ? { full_output_path: snapshot.fullOutputPath } : {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
					total_lines: snapshot.truncation.totalLines,
					total_bytes: snapshot.truncation.totalBytes,
				};
				const text = withHeader(snapshot, body, { kind: "exit", code: exitCode, seconds: wallTimeSeconds });
				return {
					content: [{ type: "text", text }],
					details,
					structuredContent,
					...(exitCode !== 0 ? { isError: true } : {}),
				};
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
