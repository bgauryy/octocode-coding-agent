import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { timedTool } from "../shared/render/rows.ts";
import { DebugSession } from "./session.ts";

function resultText(value: unknown): string {
	const json = JSON.stringify(value);
	return json.length <= 32_000 ? json : JSON.stringify({ truncated: true, preview: json.slice(0, 32_000) });
}

const MAX_ADAPTER_ARGS = 32;
const MAX_BREAKPOINT_SOURCES = 32;
const MAX_LINES = 100;

/**
 * The limits the schema leaves out: Octocode tool schemas describe shape only (a refused bound echoes every argument
 * back), so the tool checks counts and ranges itself and names the one that failed.
 */
function checkDebugInput(params: {
	adapterArgs?: string[];
	breakpoints?: Array<{ lines: number[] }>;
	lines?: number[];
	generation?: number;
	variablesReference?: number;
}): void {
	const lines = (list: number[], where: string) => {
		if (list.length > MAX_LINES) throw new Error(`${where}: at most ${MAX_LINES} lines`);
		if (list.some((line) => !Number.isSafeInteger(line) || line < 1))
			throw new Error(`${where}: lines are 1-based integers`);
	};
	if ((params.adapterArgs?.length ?? 0) > MAX_ADAPTER_ARGS) throw new Error(`adapterArgs: at most ${MAX_ADAPTER_ARGS}`);
	if ((params.breakpoints?.length ?? 0) > MAX_BREAKPOINT_SOURCES)
		throw new Error(`breakpoints: at most ${MAX_BREAKPOINT_SOURCES} sources`);
	for (const item of params.breakpoints ?? []) lines(item.lines, "breakpoints");
	if (params.lines) lines(params.lines, "lines");
	if (params.generation !== undefined && params.generation < 0) throw new Error("generation: not negative");
	if (params.variablesReference !== undefined && params.variablesReference < 1)
		throw new Error("variablesReference: a positive reference from scopes or variables");
}

/** Opt-in native debugger. The shared tool-call permission gate must authorize launch before execute. */
export function registerDebugTool(pi: ExtensionAPI): void {
	let session: DebugSession | undefined;
	let pending: AbortController | undefined;
	let epoch = 0;
	const close = () => {
		epoch++;
		pending?.abort();
		pending = undefined;
		session?.close();
		session = undefined;
	};
	pi.registerTool(
		timedTool(
			{
				name: "debug",
				label: "Debugger",
				defaultActive: true,
				description:
					"Control one explicitly configured local DAP stdio adapter. Launch can execute and mutate repository code and requires permission. Launch with adapter executable, adapterArgs, launch arguments and optional source breakpoints; then use output, stack, scopes, variables, continue, next, stepIn, stepOut, breakpoints or terminate. All inspection and stepping calls require the current stop generation; frame and variable IDs expire on resume. Attach, evaluate, custom requests, runInTerminal and writes are unsupported.",
				promptSnippet: "Inspect stopped runtime state through an optional DAP adapter",
				promptGuidelines: [
					"Use debug when a failing test or runtime behavior needs stopped-state inspection that logs and bash output cannot give.",
				],
				parameters: Type.Object({
					action: Type.Union([
						Type.Literal("launch"),
						Type.Literal("breakpoints"),
						Type.Literal("continue"),
						Type.Literal("next"),
						Type.Literal("stepIn"),
						Type.Literal("stepOut"),
						Type.Literal("stack"),
						Type.Literal("scopes"),
						Type.Literal("variables"),
						Type.Literal("output"),
						Type.Literal("terminate"),
					]),
					adapter: Type.Optional(Type.String({ description: "Explicit executable path or command for launch" })),
					adapterArgs: Type.Optional(
						Type.Array(Type.String(), { description: `Adapter arguments, at most ${MAX_ADAPTER_ARGS}` }),
					),
					launch: Type.Optional(
						Type.Record(Type.String(), Type.Unknown(), { description: "Adapter-specific DAP launch arguments" }),
					),
					breakpoints: Type.Optional(
						Type.Array(
							Type.Object({
								source: Type.String(),
								lines: Type.Array(Type.Integer(), { description: `1-based lines, at most ${MAX_LINES}` }),
							}),
							{ description: `At most ${MAX_BREAKPOINT_SOURCES} sources` },
						),
					),
					source: Type.Optional(Type.String()),
					lines: Type.Optional(Type.Array(Type.Integer(), { description: `1-based lines, at most ${MAX_LINES}` })),
					generation: Type.Optional(Type.Integer()),
					threadId: Type.Optional(Type.Integer()),
					frameId: Type.Optional(Type.Integer()),
					variablesReference: Type.Optional(Type.Integer()),
				}),
				async execute(_id, params, signal, _onUpdate, ctx) {
					signal?.throwIfAborted();
					checkDebugInput(params);
					if (params.action === "terminate") {
						if (pending) {
							close();
							return { content: [{ type: "text" as const, text: "Pending debug launch cancelled" }], details: {} };
						}
						if (!session) return { content: [{ type: "text" as const, text: "No active debug session" }], details: {} };
						const old = session;
						session = undefined;
						await old.terminate();
						return { content: [{ type: "text" as const, text: "Debug session terminated" }], details: {} };
					}
					if (params.action === "launch") {
						if (session?.state === "ended") {
							session.close();
							session = undefined;
						}
						if (session || pending)
							throw new Error("A debug session is already active or starting; terminate it first");
						if (!params.adapter || !params.launch) throw new Error("adapter and launch arguments are required");
						const generation = epoch;
						const controller = new AbortController();
						pending = controller;
						const abort = () => controller.abort();
						signal?.addEventListener("abort", abort, { once: true });
						let result: Awaited<ReturnType<typeof DebugSession.launch>>;
						try {
							result = await DebugSession.launch(
								{
									adapter: params.adapter,
									adapterArgs: params.adapterArgs,
									cwd: ctx.cwd,
									launch: params.launch,
									breakpoints: params.breakpoints,
								},
								controller.signal,
							);
						} finally {
							signal?.removeEventListener("abort", abort);
							if (pending === controller) pending = undefined;
						}
						if (generation !== epoch || signal?.aborted || controller.signal.aborted) {
							result.session.close();
							throw new Error("Debug launch expired before activation");
						}
						session = result.session;
						return {
							content: [
								{
									type: "text" as const,
									text: resultText({
										state: session.state,
										generation: session.generation,
										breakpoints: result.breakpoints,
										output: session.output(),
									}),
								},
							],
							details: {},
						};
					}
					if (!session) throw new Error("No active debug session; launch first");
					const result = await session.action(params.action, params, signal);
					return { content: [{ type: "text" as const, text: resultText(result) }], details: {} };
				},
			},
			// Session actions serialize internally; terminate must be able to abort an in-flight launch.
			{ exclusive: false },
		),
	);
	pi.on("session_before_switch", close);
	pi.on("session_before_fork", close);
	pi.on("session_shutdown", close);
}
