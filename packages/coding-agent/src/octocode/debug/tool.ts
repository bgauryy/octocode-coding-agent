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
/** How long a session switch, fork or shutdown waits for the adapter to end the debuggee before stopping the adapter. */
const END_WAIT_MS = 2_000;

/** Asks the adapter to end the debuggee (DAP terminate, else disconnect{terminateDebuggee}) within END_WAIT_MS, then stops it. */
async function endSession(session: DebugSession): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			session.terminate(),
			new Promise((resolve) => {
				timer = setTimeout(resolve, END_WAIT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
		session.close();
	}
}

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

// Sent with every request: keep it to what decides a call. The adapter recipes are rare, so `launch` without an adapter
// returns them (`LAUNCH_HELP`) instead; docs/debugging.md holds the detail.
const DESCRIPTION = `Source-level debugger over DAP: line breakpoints, exception stops and stepping; no attach, evaluation or conditional breakpoints. launch without adapter returns the adapter recipes (lldb-dap, debugpy, js-debug) and runs nothing; launch with one runs the program (needs permission). Actions that run the program wait up to ${STOP_WAIT_MS / 1000}s, then return state, generation, frame and output. At a stop, pass the latest generation to scopes with frame.id, then variables; a resume replaces them. While running, call output again, pause or terminate; after ended, launch again.`;

/** What `launch` without an adapter returns: how to launch each supported adapter, and the limits a launch is checked against. */
const LAUNCH_HELP = [
	"Nothing was launched. Call launch again with adapter, adapterArgs and launch; adapter is one executable (no shell), every further word goes in adapterArgs; breakpoints go in launch or later in the breakpoints action.",
	'- C, C++, Swift, Rust (lldb-dap): adapter "xcrun", adapterArgs ["lldb-dap"] (or adapter "lldb-dap"); launch {program, args, cwd}.',
	'- Python (debugpy installed): adapter "python3", adapterArgs ["-m","debugpy.adapter"]; launch {program, console: "internalConsole", subProcess: false}, or {module, args} in place of program.',
	'- Node, TypeScript and vitest (js-debug): adapter "node", adapterArgs ["<js-debug>/src/dapDebugServer.js","0","127.0.0.1"], tcp true; launch {type: "pwa-node", program, args, cwd, outputCapture: "std"}; exceptions ["all"] for ES modules.',
	"The result returns state, generation, reason, frame, exception, exitCode and output, and lists each breakpoint the adapter verified and the exception filters it offers.",
	`Limits: ${MAX_ADAPTER_ARGS} adapterArgs, ${MAX_BREAKPOINT_SOURCES} breakpoint files, ${MAX_LINES} lines per file, ${MAX_EXCEPTION_FILTERS} exception filters.`,
].join("\n");

/** Opt-in native debugger. The shared tool-call permission gate must authorize launch before execute. */
export function registerDebugTool(api: ExtensionAPI): void {
	let session: DebugSession | undefined;
	let pending: AbortController | undefined;
	let epoch = 0;
	const close = async () => {
		epoch++;
		pending?.abort();
		pending = undefined;
		const old = session;
		session = undefined;
		if (old) await endSession(old);
	};
	api.registerTool(
		timedTool(
			{
				name: "debug",
				label: "Debugger",
				defaultActive: true,
				promptSnippet:
					"When logs and test output cannot explain a failure and you need to stop at a line and inspect state",
				description: DESCRIPTION,
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
					adapterArgs: Type.Optional(Type.Array(Type.String(), { description: "launch: arguments for adapter" })),
					launch: Type.Optional(
						Type.Unsafe<Record<string, unknown>>({
							type: "object",
							description: "launch: DAP launch arguments for the program",
						}),
					),
					tcp: Type.Optional(Type.Boolean({ description: "launch: adapter prints a loopback port" })),
					exceptions: Type.Optional(Type.Array(Type.String(), { description: "launch: filter ids to stop on" })),
					breakpoints: Type.Optional(
						Type.Array(
							Type.Object({
								source: Type.String({ description: "absolute path" }),
								lines: Type.Array(Type.Integer()),
							}),
							{ description: `launch: at most ${MAX_BREAKPOINT_SOURCES} files` },
						),
					),
					source: Type.Optional(Type.String({ description: "breakpoints: absolute path" })),
					lines: Type.Optional(
						Type.Array(Type.Integer(), {
							description: "breakpoints: all lines for source (1-based, at most 100); [] clears",
						}),
					),
					generation: Type.Optional(
						Type.Integer({ description: "stack, scopes, variables and steps: from the latest stopped result" }),
					),
					threadId: Type.Optional(
						Type.Integer({
							description: "pause, stack, steps: defaults to the stopped thread; stack without one lists threads",
						}),
					),
					frameId: Type.Optional(Type.Integer({ description: "scopes: frame id from the stop result or stack" })),
					variablesReference: Type.Optional(Type.Integer({ description: "variables: from scopes or variables" })),
				}),
				async execute(_id, params, signal, _onUpdate, ctx) {
					signal?.throwIfAborted();
					checkDebugInput(params);
					if (params.action === "terminate") {
						if (pending) {
							await close();
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
						// The permission gate lets this through without asking: it starts nothing (`permission/gate/classify.ts`).
						if (!params.adapter) return { content: [{ type: "text" as const, text: LAUNCH_HELP }], details: {} };
						if (session?.state === "ended") {
							session.close();
							session = undefined;
						}
						if (session || pending)
							throw new Error("A debug session is already active or starting; terminate it first");
						if (!params.launch)
							throw new Error("launch arguments are required; launch without adapter shows the recipes");
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
							// The program may already run: end it as a session switch would.
							await endSession(result.session);
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
