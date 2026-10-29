import { body, objects, type DapProtocol } from "./protocol.ts";

const INITIALIZED_MS = 10_000;

export interface HandshakeInput {
	request: "launch" | "attach";
	args: Record<string, unknown>;
	breakpoints: Array<{ source: string; lines: number[] }>;
	/** Exception filter ids to enable; ids the adapter does not advertise are reported, not sent. */
	exceptions: string[];
	/** Advertise `startDebugging` support: only when the caller can open child connections. */
	startDebugging: boolean;
	/** Receives the capabilities as soon as initialize answers; a debuggee can stop before launch is acknowledged. */
	onCapabilities?: (capabilities: Record<string, unknown>) => void;
}

export interface HandshakeResult {
	capabilities: Record<string, unknown>;
	breakpoints: unknown[];
	exceptions: { available: string[]; enabled: string[]; unknown: string[] };
}

/**
 * initialize → launch/attach (left outstanding: many adapters answer it only after configurationDone) → initialized →
 * breakpoints and exception filters → configurationDone. The caller closes the connection on failure.
 */
export async function handshake(
	protocol: DapProtocol,
	input: HandshakeInput,
	signal?: AbortSignal,
): Promise<HandshakeResult> {
	let cancelInitialized = () => {};
	const initialized = new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			off();
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve();
		};
		const timer = setTimeout(() => finish(new Error("DAP initialized event timed out")), INITIALIZED_MS);
		const off = protocol.on("initialized", () => finish());
		const abort = () => finish(new Error("DAP launch aborted"));
		signal?.addEventListener("abort", abort, { once: true });
		protocol.onClose(() => finish(new Error("DAP adapter closed before initialized")));
		cancelInitialized = () => finish(new Error("DAP launch cancelled"));
	});
	void initialized.catch(() => undefined);
	try {
		const capabilities = body(
			await protocol.request(
				"initialize",
				{
					clientID: "octocode",
					adapterID: "explicit",
					pathFormat: "path",
					linesStartAt1: true,
					columnsStartAt1: true,
					supportsRunInTerminalRequest: false,
					supportsStartDebuggingRequest: input.startDebugging,
					supportsVariableType: true,
				},
				signal,
			),
		);
		input.onCapabilities?.(capabilities);
		const available = objects(capabilities.exceptionBreakpointFilters)
			.map((filter) => filter.filter)
			.filter((id): id is string => typeof id === "string");
		const exceptions = {
			available,
			enabled: input.exceptions.filter((id) => available.includes(id)),
			unknown: input.exceptions.filter((id) => !available.includes(id)),
		};
		const launched = protocol.request(input.request, { ...input.args, noDebug: false }, signal);
		void launched.catch(() => undefined);
		const configure = async (): Promise<unknown[]> => {
			await initialized;
			const breakpoints: unknown[] = [];
			for (const item of input.breakpoints) {
				const result = await protocol.request(
					"setBreakpoints",
					{ source: { path: item.source }, breakpoints: item.lines.map((line) => ({ line })), sourceModified: false },
					signal,
				);
				breakpoints.push({ source: item.source, breakpoints: objects(body(result).breakpoints) });
			}
			if (exceptions.enabled.length)
				await protocol.request("setExceptionBreakpoints", { filters: exceptions.enabled }, signal);
			if (capabilities.supportsConfigurationDoneRequest === true)
				await protocol.request("configurationDone", {}, signal);
			return breakpoints;
		};
		// A failed launch can precede a secondary configuration error, while a successful launch may await configurationDone.
		const launchFailure = launched.then(() => new Promise<never>(() => {}));
		const breakpoints = await Promise.race([configure(), launchFailure]);
		await launched;
		return { capabilities, breakpoints, exceptions };
	} catch (error) {
		cancelInitialized();
		throw error;
	}
}
