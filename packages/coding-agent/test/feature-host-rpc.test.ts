import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";
import {
	createSandbox,
	QUIET_ARGS,
	SCRIPTED_MODEL_ARGS,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
	writeSettings,
} from "./helpers/feature-host-cli.ts";

/**
 * The feature host through `octocode --mode rpc`, a real child process: native features register, the permission
 * prompt reaches the host as `extension_ui_request`, and the settings `extensions` list can no longer load code.
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

function rpcClient(args: string[], options: Partial<ConstructorParameters<typeof RpcClient>[0]> = {}): RpcClient {
	const invocation = getCliInvocation();
	client = new RpcClient({
		invocation: { command: invocation.command, args: invocation.prefix },
		cwd: sandbox.project,
		args: [...QUIET_ARGS, ...args],
		env: sandbox.env,
		...options,
	});
	return client;
}

const commandNames = async (rpc: RpcClient) => (await rpc.getCommands()).map((command) => command.name);

describe("native features over RPC", () => {
	it("get_commands lists the native and built-in commands, each owned by its feature", async () => {
		sandbox = createSandbox();
		const rpc = rpcClient(["--no-builtin-tools"]);
		await rpc.start();
		const commands = await rpc.getCommands();
		const byName = new Map(commands.map((command) => [command.name, command]));
		for (const name of ["permissions", "agents", "plan"]) {
			expect(byName.get(name), `/${name}`).toMatchObject({ source: "extension", sourceInfo: { owner: "native" } });
		}
		for (const name of ["mcp", "llama"]) {
			expect(byName.get(name), `/${name}`).toMatchObject({ source: "extension", sourceInfo: { owner: "builtin" } });
		}
		expect(new Set(commands.map((command) => command.name)).size).toBe(commands.length);
	}, 90_000);

	it("starts with an Ignored extension diagnostic when settings name a code file", async () => {
		sandbox = createSandbox();
		const code = join(sandbox.directory, "startup.mjs");
		const ran = join(sandbox.directory, "ran.txt");
		writeFileSync(
			code,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(ran)}, "loaded"); export default () => {};`,
		);
		writeSettings(sandbox, { extensions: [code] });
		const rpc = rpcClient([]);
		await rpc.start();
		expect(await rpc.getState()).toHaveProperty("sessionId");
		expect(await commandNames(rpc)).toContain("permissions");
		expect(rpc.getStderr()).toMatch(
			/Ignored extension\. User code extensions are not supported; use plugins and hooks \(see PLUGINS\.md\)/,
		);
		expect(rpc.getStderr()).toContain(code);
		expect(existsSync(ran), "the module was never imported").toBe(false);
	}, 90_000);

	it.each([
		{ settings: ["-builtin:mcp"], args: [] as string[], mcp: true, llama: true },
		{ settings: ["-builtin:llama.cpp"], args: [], mcp: true, llama: false },
		{ settings: [], args: ["--no-mcp"], mcp: false, llama: true },
	])(
		"switches built-ins by $settings $args",
		async ({ settings, args, mcp, llama }) => {
			sandbox = createSandbox();
			if (settings.length) writeSettings(sandbox, { extensions: settings });
			const rpc = rpcClient(args);
			await rpc.start();
			const names = await commandNames(rpc);
			expect(names.includes("mcp")).toBe(mcp);
			expect(names.includes("llama")).toBe(llama);
			expect(names, "the native feature set is never switched off").toContain("permissions");
		},
		90_000,
	);
});

describe("the native permission prompt over RPC", () => {
	/** A manual-mode session whose model asks for one shell call; resolves once the prompt reaches the host. */
	async function promptForShell() {
		sandbox = createSandbox({ OCTOCODE_PERMISSION: "manual" });
		server = await startModelServer([{ tool: "bash", args: { command: "echo ran > ran.txt" } }, { text: "finished" }]);
		writeScriptedProvider(sandbox, server);
		const requests: RpcExtensionUIRequest[] = [];
		const dismissed = vi.fn();
		const rpc = rpcClient([...SCRIPTED_MODEL_ARGS], { onExtensionUIDismiss: dismissed });
		rpc.onExtensionUIRequest((request) => requests.push(request));
		let ended = false;
		rpc.onEvent((event) => {
			if (event.type === "agent_end") ended = true;
		});
		await rpc.start();
		await rpc.prompt("run the command");
		const select = () => requests.find((request) => request.method === "select" && request.permission);
		await vi.waitFor(() => expect(select(), rpc.getStderr()).toBeDefined(), { timeout: 45_000 });
		const finished = () => vi.waitFor(() => expect(ended, rpc.getStderr()).toBe(true), { timeout: 45_000 });
		return { rpc, request: select() as Extract<RpcExtensionUIRequest, { method: "select" }>, dismissed, finished };
	}
	const ran = () => join(sandbox.project, "ran.txt");

	it("arrives as a select request and runs the call once the host allows it", async () => {
		const { rpc, request, finished } = await promptForShell();
		expect(request).toMatchObject({
			type: "extension_ui_request",
			method: "select",
			permission: { toolName: "bash" },
		});
		expect(request.options).toContain(request.permission?.allowOnce);
		expect(existsSync(ran()), "nothing runs before the answer").toBe(false);
		await rpc.respondToExtensionUIRequest({
			type: "extension_ui_response",
			id: request.id,
			value: request.permission!.allowOnce,
		});
		await finished();
		expect(readFileSync(ran(), "utf8").trim()).toBe("ran");
	}, 120_000);

	it("refuses the call when the host cancels the dialog", async () => {
		const { rpc, request, finished } = await promptForShell();
		await rpc.respondToExtensionUIRequest({ type: "extension_ui_response", id: request.id, cancelled: true });
		await finished();
		expect(existsSync(ran())).toBe(false);
	}, 120_000);

	it("tells the host to close the dialog when the run is aborted, and runs nothing", async () => {
		const { rpc, request, dismissed, finished } = await promptForShell();
		await rpc.abort();
		await vi.waitFor(() => expect(dismissed).toHaveBeenCalledWith(request.id), { timeout: 30_000 });
		await finished();
		expect(existsSync(ran())).toBe(false);
	}, 120_000);
});
