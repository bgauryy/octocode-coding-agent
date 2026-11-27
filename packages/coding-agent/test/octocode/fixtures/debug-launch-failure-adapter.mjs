let buffer = Buffer.alloc(0);
let sequence = 0;
let pendingLaunch;
const fail = process.argv.includes("--fail-launch");
const failConfig = process.argv.includes("--fail-configuration");

function send(message) {
	const body = Buffer.from(JSON.stringify({ seq: ++sequence, ...message }));
	process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function respond(request, success = true, message) {
	send({ type: "response", request_seq: request.seq, command: request.command, success, ...(message ? { message } : {}) });
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
		if (buffer.length < end + 4 + length) return;
		const request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
		buffer = buffer.subarray(end + 4 + length);
		if (request.type !== "request") continue;
		switch (request.command) {
			case "initialize":
				send({ type: "response", request_seq: request.seq, command: request.command, success: true, body: { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true } });
				break;
			case "launch":
				send({ type: "event", event: "initialized" });
				if (fail) respond(request, false, "launch root cause");
				else pendingLaunch = request;
				break;
			case "configurationDone":
				respond(
					request,
					!fail && !failConfig,
					fail ? "configuration consequence" : failConfig ? "configuration root cause" : undefined,
				);
				if (!fail && !failConfig && pendingLaunch) respond(pendingLaunch);
				break;
			case "terminate":
				respond(request);
				break;
			default:
				respond(request, false, "unexpected request");
		}
	}
});
