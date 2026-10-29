// Behaves like js-debug's dapDebugServer: prints its loopback address, and the root session asks the client to open
// a child connection (startDebugging with __pendingTargetId) that carries the debuggee's stops.
import { createServer } from "node:net";

const run = process.argv.includes("--run");
let root;
let children = 0;
let rootDisconnect;
const server = createServer((socket) => connection(socket));
server.listen(0, "127.0.0.1", () => console.log(`Debug server listening at 127.0.0.1:${server.address().port}`));

function connection(socket) {
	let buffer = Buffer.alloc(0);
	let seq = 0;
	let child = false;
	let launch;
	let breakpoints = [];
	const send = (message) => {
		const body = Buffer.from(JSON.stringify({ seq: ++seq, ...message }));
		if (!socket.destroyed) socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
	};
	const event = (event, body = {}) => send({ type: "event", event, body });
	const respond = (request, body = {}) =>
		send({ type: "response", request_seq: request.seq, command: request.command, success: true, body });
	const self = { event, end: () => socket.end() };
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (true) {
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
			if (buffer.length < end + 4 + length) return;
			const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
			buffer = buffer.subarray(end + 4 + length);
			if (message.type === "response") {
				if (message.command === "startDebugging" && !message.success) event("output", { output: "child refused\n" });
				continue;
			}
			const args = message.arguments ?? {};
			switch (message.command) {
				case "initialize":
					respond(message, {
						supportsConfigurationDoneRequest: true,
						exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught Exceptions" }],
					});
					if (!args.supportsStartDebuggingRequest) event("output", { output: "client cannot start children\n" });
					event("initialized");
					break;
				case "launch":
				case "attach":
					child = typeof args.__pendingTargetId === "string";
					if (child) children++;
					else root = self;
					launch = message;
					break;
				case "setBreakpoints":
					breakpoints = args.breakpoints.map((b) => b.line);
					respond(message, {
						breakpoints: args.breakpoints.map((b) => (child ? { verified: true, line: b.line } : { verified: false, message: "Unbound breakpoint" })),
					});
					break;
				case "setExceptionBreakpoints":
					if (child) event("output", { category: "stdout", output: `child exceptions: ${args.filters.join(",")}\n` });
					respond(message);
					break;
				case "configurationDone":
					respond(message);
					// Like js-debug, answer launch only after configurationDone.
					if (launch) respond(launch);
					if (!child)
						send({ type: "request", command: "startDebugging", arguments: { request: "launch", configuration: { type: "pwa-node", __pendingTargetId: "t1" } } });
					else if (!run && breakpoints.includes(3)) event("stopped", { reason: "breakpoint", threadId: 7 });
					break;
				case "threads":
					respond(message, { threads: child ? [{ id: 7, name: "main" }] : [] });
					break;
				case "stackTrace":
					respond(message, { stackFrames: [{ id: 1001, name: "main", line: 3, column: 1, source: { path: "/w/app.ts" } }] });
					break;
				case "scopes":
					respond(message, { scopes: [{ name: "Local", variablesReference: 2001 }] });
					break;
				case "variables":
					respond(message, { variables: [{ name: "answer", value: "42", variablesReference: 0 }] });
					break;
				case "pause":
					respond(message);
					event("stopped", { reason: "pause", threadId: args.threadId });
					break;
				case "continue":
					respond(message);
					event("output", { category: "stdout", output: "done\n" });
					event("exited", { exitCode: 0 });
					event("terminated");
					setTimeout(() => {
						socket.end();
						root?.event("terminated");
					}, 10);
					break;
				case "disconnect":
					if (!child && children > 0) {
						rootDisconnect = () => {
							respond(message);
							event("terminated");
						};
						break;
					}
					respond(message);
					event("terminated");
					break;
				default:
					send({ type: "response", request_seq: message.seq, command: message.command, success: false, message: "unsupported" });
			}
		}
	});
	socket.on("close", () => {
		if (!child) return;
		children--;
		if (children === 0) rootDisconnect?.();
	});
	socket.on("error", () => undefined);
}
