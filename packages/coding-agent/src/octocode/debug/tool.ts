import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { timedTool } from "../shared/render/rows.ts";
import { DebugSession, STOP_WAIT_MS } from "./session.ts";

function resultText(value: unknown): string {
	const json = JSON.stringify(value);
	return json.length <= 32_000 ? json : JSON.stringify({ truncated: true, preview: json.slice(0, 32_000) });
}

const MAX_ADAPTER_ARGS = 32;
const MAX_BREAKPOINT_SOURCES = 32;
const MAX_LINES = 100;
const MAX_EXCEPTION_FILTERS = 16;

/**
 * The limits the schema leaves out: Octocode tool schemas describe shape only (a refused bound echoes every argument
 * back), so the tool checks counts and ranges itself and names the one that failed.
 */
function checkDebugInput(params: {
	adapterArgs?: string[];
	breakpoints?: Array<{ lines: number[] }>;
	lines?: number[];
	exceptions?: string[];
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
	if ((params.exceptions?.length ?? 0) > MAX_EXCEPTION_FILTERS)
		throw new Error(`exceptions: at most ${MAX_EXCEPTION_FILTERS} filter ids`);
	if (params.generation !== undefined && params.generation < 0) throw new Error("generation: not negative");
	if (params.variablesReference !== undefined && params.variablesReference < 1)
		throw new Error("variablesReference: a positive reference from scopes or variables");
}

// Sent with every request: keep it to what decides a call. docs/debugging.md holds the detail.
const DESCRIPTION = `Debug a program when logs and test output cannot explain a failure: line breakpoints, exception stops and stepping; no attach, evaluation or conditional breakpoints. launch runs the program (needs permission) through a DAP adapter: lldb-dap ("xcrun" ["lldb-dap"], or "lldb-dap"; launch {program, args, cwd}); "python3" ["-m","debugpy.adapter"] (launch {program} or {module, args}, console "internalConsole", subProcess false); js-debug for Node, TypeScript and vitest: "node" ["<js-debug>/src/dapDebugServer.js","0","127.0.0.1"] with tcp true (launch {type: "pwa-node", program, args, cwd, outputCapture: "std"}; exceptions ["all"] for ES modules). Actions that run the program wait up to ${STOP_WAIT_MS / 1000}s, then return state, generation, reason, frame, exception, exitCode and output. At a stop, pass the latest generation to scopes with frame.id, then variables; a resume replaces them. While running, call output again, pause or terminate; after ended, launch again.`;

/** Opt-in native debugger. The shared tool-call permission gate must authorize launch before execute. */
export function registerDebugTool(api: ExtensionAPI): void {
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
	api.registerTool(
		timedTool(
			{
				name: "debug",
				label: "Debugger",
				defaultActive: true,
				description: DESCRIPTION,
				promptSnippet: "Debug a program: breakpoints, stepping, stack, variables",
				parameters: Type.Object({
					action: StringEnum([
						"launch",
						"breakpoints",
						"continue",
						"next",
						"stepIn",
						"stepOut",
						"stack",
						"scopes",
						"variables",
						"pause",
						"output",
						"terminate",
					] as const),
					adapter: Type.Optional(Type.String({ description: "launch: one executable, no shell" })),
					adapterArgs: Type.Optional(Type.Array(Type.String())),
					launch: Type.Optional(
						Type.Unsafe<Record<string, unknown>>({ type: "object", description: "launch: adapter config" }),
					),
					tcp: Type.Optional(Type.Boolean({ description: "launch: adapter prints a loopback port" })),
					exceptions: Type.Optional(Type.Array(Type.String(), { description: "launch: filter ids to stop on" })),
					breakpoints: Type.Optional(
						Type.Array(
							Type.Object({
								source: Type.String(),
								lines: Type.Array(Type.Integer()),
							}),
							{ description: `launch: at most ${MAX_BREAKPOINT_SOURCES} files` },
						),
					),
					source: Type.Optional(Type.String({ description: "breakpoints: absolute path" })),
					lines: Type.Optional(Type.Array(Type.Integer(), { description: "breakpoints: all lines; [] clears" })),
					generation: Type.Optional(
						Type.Integer({ description: "stack, scopes, variables and steps: from the latest stopped result" }),
					),
					threadId: Type.Optional(Type.Integer()),
					frameId: Type.Optional(Type.Integer({ description: "scopes" })),
					variablesReference: Type.Optional(Type.Integer({ description: "variables: from scopes or variables" })),
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
						const warning = await old.terminate();
						const text = warning ? `Debug session terminated; ${warning}` : "Debug session terminated";
						return { content: [{ type: "text" as const, text }], details: {} };
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
									exceptions: params.exceptions,
									tcp: params.tcp,
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
						// Wait for the first stop or exit, so the launch result already says where the program is.
						const status = (await session.action("output", {}, signal)) as Record<string, unknown>;
						return {
							content: [
								{
									type: "text" as const,
									text: resultText({ breakpoints: result.breakpoints, exceptions: result.exceptions, ...status }),
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
	api.on("session_before_switch", close);
	api.on("session_before_fork", close);
	api.on("session_shutdown", close);
}
