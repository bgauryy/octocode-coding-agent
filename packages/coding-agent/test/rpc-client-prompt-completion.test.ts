import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcConnection } from "../src/modes/rpc/rpc-client/connection.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});

async function fixture(body: string) {
	const directory = mkdtempSync(join(tmpdir(), "octocode-rpc-prompt-"));
	const entry = join(directory, "child.mjs");
	writeFileSync(
		entry,
		`import { createInterface } from "node:readline";
const output = value => process.stdout.write(JSON.stringify(value) + "\\n");
const reply = (command, data) => output({type:"response", id:command.id, command:command.type, success:true, data});
${body}
`,
	);
	const client = new RpcClient({ invocation: { command: process.execPath, args: [entry] } });
	cleanups.push(async () => {
		await client.stop();
		rmSync(directory, { recursive: true, force: true });
	});
	await client.start();
	const connection = (client as unknown as { connection: RpcConnection }).connection;
	const subscribe = connection.onEvent.bind(connection);
	const unsubscribed = vi.fn();
	vi.spyOn(connection, "onEvent").mockImplementation((listener) => {
		const unsubscribe = subscribe(listener);
		return () => {
			unsubscribed();
			unsubscribe();
		};
	});
	return { client, unsubscribed };
}

it("completes a no-work handled command without waiting for agent_settled and removes its event subscription", async () => {
	const { client, unsubscribed } = await fixture(`createInterface({input:process.stdin}).on("line", line => {
const command = JSON.parse(line);
if (!command.waitForCompletion) throw new Error("Completion was not requested");
reply(command, {disposition:"handled"});
});`);
	await expect(client.promptAndWait("/nothing", undefined, 1000)).resolves.toEqual([]);
	expect(unsubscribed).toHaveBeenCalledOnce();
});

it("collects nested follow-up events after the first agent_settled until the correlated prompt response", async () => {
	const { client, unsubscribed } = await fixture(`let pending;
createInterface({input:process.stdin}).on("line", line => {
const command = JSON.parse(line);
if (command.type === "prompt") {
  if (!command.waitForCompletion) throw new Error("Completion was not requested");
  pending = command; output({type:"agent_settled", aborted:false});
} else {
  output({type:"agent_start"}); output({type:"agent_settled", aborted:false});
  reply(pending, {disposition:"handled"}); reply(command, {});
}
});`);
	const firstSettled = Promise.withResolvers<void>();
	const off = client.onEvent((event) => {
		if (event.type === "agent_settled") firstSettled.resolve();
	});
	let complete = false;
	const pending = client.promptAndWait("/nested").then((events) => {
		complete = true;
		return events;
	});
	await firstSettled.promise;
	await Promise.resolve();
	expect(complete).toBe(false);
	await client.getState();
	await expect(pending).resolves.toEqual([
		{ type: "agent_settled", aborted: false },
		{ type: "agent_start" },
		{ type: "agent_settled", aborted: false },
	]);
	expect(unsubscribed).toHaveBeenCalledOnce();
	off();
});

it("times out and unsubscribes without aborting or replaying the submitted prompt", async () => {
	const { client, unsubscribed } = await fixture(`const commands = [];
createInterface({input:process.stdin}).on("line", line => {
const command = JSON.parse(line); commands.push(command.type);
if (command.type === "get_state") reply(command, {commands});
});`);
	await expect(client.promptAndWait("long work", undefined, 30)).rejects.toThrow(
		"Timeout waiting for response to prompt",
	);
	expect(unsubscribed).toHaveBeenCalledOnce();
	await expect(client.getState()).resolves.toMatchObject({ commands: ["prompt", "get_state"] });
});

it("unsubscribes after a prompt rejection and preserves the not-sent marker", async () => {
	const { client, unsubscribed } = await fixture(`createInterface({input:process.stdin}).on("line", line => {
const command = JSON.parse(line);
output({type:"response", id:command.id, command:command.type, success:false, error:"Busy", execution:"not-sent"});
});`);
	await expect(client.promptAndWait("rejected")).rejects.toMatchObject({ message: "Busy", execution: "not-sent" });
	expect(unsubscribed).toHaveBeenCalledOnce();
});
