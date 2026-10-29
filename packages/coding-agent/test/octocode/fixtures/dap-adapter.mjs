let buffer = Buffer.alloc(0);
let seq = 0;
let configured = false;
let exceptions = [];
const send = (message) => {
	const body = Buffer.from(JSON.stringify({ seq: ++seq, ...message }));
	process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
};
const event = (event, body = {}) => send({ type: "event", event, body });
const respond = (request, body = {}) => send({ type: "response", request_seq: request.seq, command: request.command, success: true, body });
function receive(chunk) {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
		if (buffer.length < end + 4 + length) return;
		const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
		buffer = buffer.subarray(end + 4 + length);
		if (request.type !== "request") continue;
		if (process.argv.includes("--hang")) continue;
		if (process.argv.includes("--malformed")) {
			process.stdout.write("Content-Length: 999999999\r\n\r\n");
			continue;
		}
		switch (request.command) {
			case "initialize":
				if (process.argv.includes("--wrong-command")) send({ type: "response", request_seq: request.seq, command: "threads", success: true });
				else
					respond(request, {
						supportsConfigurationDoneRequest: true,
						supportsTerminateRequest: true,
						supportsExceptionInfoRequest: true,
						exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught" }, { filter: "raised", label: "Raised" }],
					});
				break;
			case "launch":
				if (process.argv.includes("--exit-before-initialized")) process.exit(0);
				if (!process.argv.includes("--omit-initialized")) event("initialized");
				respond(request);
				if (configured) event("stopped", { reason: "breakpoint", threadId: 1 });
				break;
			case "configurationDone":
				configured = true;
				respond(request);
				if (process.argv.includes("--terminate-after-config")) {
					event("output", { category: "stdout", output: "bye\n" });
					event("exited", { exitCode: 3 });
					event("terminated");
					// An adapter must not be able to revive a closed session with buffered events.
					event("stopped", { reason: "late", threadId: 1 });
				}
				else if (process.argv.includes("--run")) break;
				else if (exceptions.includes("uncaught") && process.argv.includes("--throw"))
					event("stopped", { reason: "exception", description: "Paused on exception", text: "Error: boom", threadId: 1 });
				else event("stopped", { reason: "breakpoint", threadId: 1 });
				break;
			case "setExceptionBreakpoints": exceptions = request.arguments.filters; respond(request); break;
			case "exceptionInfo": respond(request, { exceptionId: "Error", description: "boom", breakMode: "unhandled", details: { message: "Error: boom" } }); break;
			case "pause": respond(request); event("stopped", { reason: "pause", threadId: request.arguments.threadId }); break;
			case "setBreakpoints": respond(request, { breakpoints: request.arguments.breakpoints.map((b) => ({ verified: true, line: b.line })) }); break;
			case "threads": respond(request, { threads: [{ id: 1, name: "main" }] }); break;
			case "stackTrace":
				if (process.argv.includes("--stale-stack")) event("stopped", { reason: "new stop", threadId: 1 });
				respond(request, { stackFrames: [{ id: 11, name: "main", line: 7, column: 1 }] }); break;
			case "scopes": respond(request, { scopes: [{ name: "locals", variablesReference: 22 }] }); break;
			case "variables": respond(request, { variables: [{ name: "value", value: "unexpected", variablesReference: 0 }] }); break;
			case "continue": case "next": case "stepIn": case "stepOut": respond(request); event("continued", { threadId: 1 }); setTimeout(() => event("stopped", { reason: "step", threadId: 1 }), 20); break;
			case "terminate":
				if (process.argv.includes("--end-before-terminate-response")) {
					event("terminated");
					process.exit(0);
				}
				respond(request);
				event("terminated");
				break;
			default: send({ type: "response", request_seq: request.seq, command: request.command, success: false, message: "unsupported" });
		}
	}
}
process.stdin.on("data", receive);
