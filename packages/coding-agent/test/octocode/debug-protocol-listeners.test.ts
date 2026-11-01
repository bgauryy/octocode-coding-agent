import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { DapProtocol } from "../../src/octocode/debug/protocol.ts";

function emit(socket: Socket, message: Record<string, unknown>): void {
	const body = Buffer.from(JSON.stringify(message));
	socket.emit("data", Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]));
}

describe("DAP event listeners", () => {
	it("keeps a listener added after another unsubscribed when an earlier one unsubscribes", () => {
		const socket = new Socket();
		const protocol = new DapProtocol(socket);
		const heard: string[] = [];
		const offA = protocol.on("stopped", () => heard.push("a"));
		const offC = protocol.on("stopped", () => heard.push("c"));
		offA();
		protocol.on("stopped", () => heard.push("b"));
		offC();
		emit(socket, { seq: 1, type: "event", event: "stopped", body: {} });
		expect(heard).toEqual(["b"]);
		protocol.close();
	});
});
