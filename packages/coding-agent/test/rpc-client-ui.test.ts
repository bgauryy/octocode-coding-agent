import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.ts";

const clients: RpcClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.stop()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startClient() {
	const dir = mkdtempSync(join(tmpdir(), "octocode-rpc-ui-"));
	dirs.push(dir);
	const cliPath = join(dir, "child.mjs");
	writeFileSync(cliPath, `
import { createInterface } from "node:readline";
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	if (command.type === "get_state") {
		output(null);
		output({ type: "response", id: "expired-request", command: "get_state", success: true, data: {} });
		output({ type: "extension_ui_request", id: "dialog-1", method: "confirm", title: "Continue?", message: "Proceed" });
		output({ type: "response", id: command.id, command: command.type, success: true, data: {} });
	} else if (command.type === "extension_ui_response") {
		output({ type: "extension_ui_request", id: "receipt", method: "notify", message: JSON.stringify(command) });
		output({ type: "agent_settled", aborted: false });
	}
});
`);
	const client = new RpcClient({ cliPath });
	clients.push(client);
	await client.start();
	return client;
}

describe("RPC client UI transport", () => {
	it("does not mislabel UI requests as session events", async () => {
		const client = await startClient();
		const events: string[] = [];
		client.onEvent((event) => events.push(event.type));
		await client.getState();
		expect(events).toEqual([]);
	});

	it.each<RpcExtensionUIResponse>([
		{ type: "extension_ui_response", id: "dialog-1", confirmed: true },
		{ type: "extension_ui_response", id: "dialog-1", value: "hello\nworld" },
		{ type: "extension_ui_response", id: "dialog-1", cancelled: true },
	])("round-trips a UI response without changing its dialog id: %j", async (response) => {
		const client = await startClient();
		const requests: RpcExtensionUIRequest[] = [];
		const unsubscribe = client.onExtensionUIRequest((request) => requests.push(request));
		await client.getState();
		expect(requests[0]).toMatchObject({ id: "dialog-1", method: "confirm" });
		const events = client.collectEvents(2000);
		await client.respondToExtensionUIRequest(response);
		expect(await events).toEqual([{ type: "agent_settled", aborted: false }]);
		const receipt = requests.find((request) => request.method === "notify");
		expect(receipt?.method === "notify" && JSON.parse(receipt.message)).toEqual(response);
		unsubscribe();
		await client.getState();
		expect(requests).toHaveLength(2);
	});

	it("rejects UI responses when the client is not started", async () => {
		await expect(
			new RpcClient().respondToExtensionUIRequest({
				type: "extension_ui_response", id: "dialog-1", cancelled: true,
			}),
		).rejects.toThrow("Client not started");
	});
});
