import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";
import {
	createSandbox,
	observeSessions,
	QUIET_ARGS,
	SCRIPTED_MODEL_ARGS,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
} from "./helpers/feature-host-cli.ts";

/**
 * The RPC host keeps handling commands while a UI request is open, and answers every open request when it closes.
 * The native producer of a UI request is the permission prompt of a manual-mode shell call; no native feature opens
 * one while a session starts.
 */
let sandbox: Sandbox;
let server: ModelServer | undefined;
let client: RpcClient | undefined;

afterEach(async () => {
	await client?.stop();
	await server?.close();
	sandbox?.cleanup();
	client = undefined;
	server = undefined;
});

it.each(["respond", "stop"])(
	"keeps RPC command ordering while a UI request is open, then handles %s",
	async (action) => {
		sandbox = createSandbox({ OCTOCODE_PERMISSION: "manual" });
		const sessions = observeSessions(sandbox);
		server = await startModelServer([{ tool: "bash", args: { command: "echo ran > ran.txt" } }, { text: "finished" }]);
		writeScriptedProvider(sandbox, server);
		const invocation = getCliInvocation();
		// Notifications and status updates are UI requests too; only the permission prompt waits for an answer.
		const ui: RpcExtensionUIRequest[] = [];
		const rpc = new RpcClient({
			invocation: { command: invocation.command, args: invocation.prefix },
			cwd: sandbox.project,
			args: [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS],
			env: sandbox.env,
		});
		client = rpc;
		rpc.onExtensionUIRequest((request) => {
			if (request.method === "select" && request.permission) ui.push(request);
		});
		await rpc.start();
		await rpc.prompt("run the command");
		// The child CLI boots in about 1s when idle and much slower while the full suite runs in parallel.
		await vi.waitFor(() => expect(ui, rpc.getStderr()).toHaveLength(1), { timeout: 45_000 });
		const ran = join(sandbox.project, "ran.txt");

		// Commands sent while the request is open are answered, each response matching its own command.
		const [state, commands] = await Promise.all([rpc.getState(), rpc.getCommands()]);
		expect(state).toHaveProperty("sessionId");
		expect(commands.map((command) => command.name)).toContain("permissions");
		expect(ui, "no second request was opened").toHaveLength(1);
		expect(existsSync(ran), "nothing runs while the request is open").toBe(false);

		if (action === "respond") {
			const request = ui[0] as Extract<RpcExtensionUIRequest, { method: "select" }>;
			await rpc.respondToExtensionUIRequest({
				type: "extension_ui_response",
				id: request.id,
				value: request.permission!.allowOnce,
			});
			await vi.waitFor(() => expect(readFileSync(ran, "utf8").trim()).toBe("ran"), { timeout: 45_000 });
		} else {
			await rpc.stop();
			expect(existsSync(ran), "stopping answers the open request as cancelled").toBe(false);
			expect(sessions.ended(), "the session shut down").toEqual(sessions.started());
		}
		expect(sessions.started()).toHaveLength(1);
	},
	120_000,
);
