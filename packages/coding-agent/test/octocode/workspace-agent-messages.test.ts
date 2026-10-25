import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { ApplicationCommand, ApplicationFrame } from "@octocodeai/octocode-contacts";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ApplicationStream } from "../../../webview/src/application-stream.ts";
import { workspaceAgent } from "./fixtures/workspace-agent.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function browser(url: string) {
	const address = new URL(url);
	const token = new URLSearchParams(address.hash.slice(1)).get("access");
	const stream = new ApplicationStream();
	const frames: ApplicationFrame[] = [];
	const socket = new WebSocket(address.origin.replace("http:", "ws:") + "/api/backlogs/live", {
		origin: address.origin,
	});
	cleanup.push(() => socket.terminate());
	socket.on("message", (data) => {
		const message = JSON.parse(data.toString());
		if (message.type !== "application") return;
		frames.push(message.data);
		stream.accept(message.data);
	});
	await once(socket, "open");
	socket.send(JSON.stringify({ token, protocolVersion: 1 }));
	await vi.waitFor(() => expect(stream.snapshot).toBeDefined());
	return {
		socket,
		stream,
		frames,
		send: async (command: ApplicationCommand) => {
			const response = await fetch(new URL("/api/application", address), {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, Origin: address.origin, "Content-Type": "application/json" },
				body: JSON.stringify(command),
				signal: AbortSignal.timeout(5000),
			});
			return { status: response.status, body: await response.json() };
		},
	};
}

it("delivers browser prompts and queued follow-ups to the owning engine and streams replies back to both views", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-agent-message-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const first = await workspaceAgent(root, "first");
	cleanup.push(first.close);
	const second = await workspaceAgent(root, "second");
	cleanup.push(second.close);
	const one = await browser(first.url);
	const two = await browser(second.url);
	const secondMessages = [...second.session.messages];
	const secondView = two.stream.snapshot?.messages;
	const command = {
		id: "browser-message",
		sessionId: first.session.sessionId,
		action: "prompt" as const,
		text: "Hello from the browser",
	};
	expect(await one.send(command)).toMatchObject({
		status: 200,
		body: { receipt: { id: command.id, status: "accepted" } },
	});
	await vi.waitFor(() => expect(one.stream.snapshot?.streaming).toBe(true));
	await vi.waitFor(() =>
		expect(one.frames.some((frame) => frame.type === "event" && frame.event.type === "message.delta")).toBe(true),
	);
	expect(await one.send(command)).toMatchObject({ status: 200 });
	expect(await two.send({ ...command, id: "wrong-session" })).toMatchObject({ status: 409 });
	await one.send({ id: "follow-up", sessionId: command.sessionId, action: "followUp", text: "Then check the result" });
	await vi.waitFor(() => expect(one.stream.snapshot?.followUp).toContain("Then check the result"));
	await vi.waitFor(
		() =>
			expect(one.stream.snapshot?.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "assistant",
						text: "first received: Hello from the browser",
						complete: true,
					}),
					expect.objectContaining({ role: "assistant", text: "first received: Then check the result", complete: true }),
				]),
			),
		{ timeout: 5000 },
	);
	expect(first.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
	expect(
		first.terminal.some(
			(event) => event.type === "message_end" && JSON.stringify(event.message).includes("Then check the result"),
		),
	).toBe(true);
	expect(second.session.messages).toEqual(secondMessages);
	expect(two.stream.snapshot?.messages).toEqual(secondView);
	one.socket.close();
	await once(one.socket, "close");
	const reconnected = await browser(first.url);
	expect(reconnected.stream.snapshot?.messages).toEqual(one.stream.snapshot?.messages);
	await two.send({
		...command,
		id: "second-message",
		sessionId: second.session.sessionId,
		text: "Only the second agent",
	});
	await vi.waitFor(() =>
		expect(two.stream.snapshot?.messages).toContainEqual(
			expect.objectContaining({ text: "second received: Only the second agent", complete: true }),
		),
	);
	expect(first.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
});
