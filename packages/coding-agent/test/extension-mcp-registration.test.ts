import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { createExtensionRuntime, loadExtensionFromFactory } from "./helpers/features.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/features/types.ts";

function setup() {
	const runtime = createExtensionRuntime();
	const events = createEventBus();
	return {
		runtime,
		load: (name: string, factory: ExtensionFactory) =>
			loadExtensionFromFactory(factory, process.cwd(), events, runtime, name),
	};
}

describe("extension MCP registration transactions", () => {
	it("rejects namespace aliases within one factory without committing its other changes", async () => {
		const { runtime, load } = setup();
		await expect(
			load("<collision>", (api) => {
				api.registerFlag("collision", { type: "boolean", default: true });
				api.registerProvider("collision", { baseUrl: "https://example.invalid" });
				api.registerMcpServer("alpha-beta", { command: "first" });
				api.registerMcpServer("alpha_beta", { command: "second" });
			}),
		).rejects.toThrow('MCP server "alpha_beta" conflicts with registered server "alpha-beta"');
		expect(runtime.mcpServers.list()).toEqual([]);
		expect(runtime.flagValues.has("collision")).toBe(false);
		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});

	it("lets another extension's registration replace an inherited server, whatever the load order", async () => {
		const { runtime, load } = setup();
		await load("builtin:mcp", (api) => api.registerMcpServer("shared", { command: "parent" }, { inherited: true }));
		await load("<plugin>", (api) => api.registerMcpServer("shared", { command: "own" }));
		expect(runtime.mcpServers.list()).toEqual([
			{ name: "shared", config: { command: "own" }, extensionPath: "<plugin>" },
		]);

		await load("<late>", (api) => api.registerMcpServer("shared2", { command: "own" }));
		await load("builtin:mcp", (api) => api.registerMcpServer("shared2", { command: "parent" }, { inherited: true }));
		expect(runtime.mcpServers.get("shared2")?.extensionPath).toBe("<late>");
		await expect(load("<other>", (api) => api.registerMcpServer("shared2", { command: "x" }))).rejects.toThrow(
			'MCP server "shared2" is already registered by extension "<late>"',
		);
	});

	it("revalidates every change before committing when another factory claimed a name", async () => {
		const { runtime, load } = setup();
		let resume!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const slow = load("<slow>", async (api) => {
			api.registerFlag("slow", { type: "boolean", default: true });
			api.registerProvider("slow", { baseUrl: "https://example.invalid" });
			api.registerMcpServer("unrelated", { command: "slow" });
			api.registerMcpServer("claimed", { command: "slow" });
			await waiting;
		});
		await load("<winner>", (api) => api.registerMcpServer("claimed", { command: "winner" }));
		resume();
		await expect(slow).rejects.toThrow('MCP server "claimed" is already registered by extension "<winner>"');
		expect(runtime.mcpServers.list()).toEqual([
			{ name: "claimed", config: { command: "winner" }, extensionPath: "<winner>" },
		]);
		expect(runtime.flagValues.has("slow")).toBe(false);
		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});

	it("merges nonconflicting concurrent factories and keeps their registrations", async () => {
		const { runtime, load } = setup();
		let resume!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const slow = load("<slow>", async (api) => {
			api.registerMcpServer("slow", { command: "slow" });
			await waiting;
		});
		await load("<fast>", (api) => api.registerMcpServer("fast", { command: "fast" }));
		resume();
		await slow;
		expect(runtime.mcpServers.list().map(({ name }) => name)).toEqual(["fast", "slow"]);
	});

	it("preserves same-owner replacement and supports unregistering before reusing a namespace", async () => {
		const { runtime, load } = setup();
		await load("<owner>", (api) => {
			api.registerMcpServer("alpha-beta", { command: "first" });
			api.registerMcpServer("alpha-beta", { command: "replacement" });
			api.unregisterMcpServer("alpha-beta");
			api.registerMcpServer("alpha_beta", { command: "final" });
		});
		expect(runtime.mcpServers.list()).toEqual([
			{ name: "alpha_beta", config: { command: "final" }, extensionPath: "<owner>" },
		]);
	});

	it("does not remove another owner's registration to reuse its namespace", async () => {
		const { runtime, load } = setup();
		await load("<owner>", (api) => api.registerMcpServer("alpha-beta", { command: "owner" }));
		await expect(
			load("<other>", (api) => {
				api.unregisterMcpServer("alpha-beta");
				api.registerMcpServer("alpha_beta", { command: "other" });
			}),
		).rejects.toThrow('MCP server "alpha_beta" conflicts with registered server "alpha-beta"');
		expect(runtime.mcpServers.list()[0].config).toEqual({ command: "owner" });
	});

	it("keeps active API changes immediate and snapshots caller-owned configurations", async () => {
		const { runtime, load } = setup();
		let api!: ExtensionAPI;
		await load("<owner>", (value) => {
			api = value;
		});
		const changed = vi.fn();
		runtime.mcpServers.setChangeListener(changed);
		const config = { command: "first", args: ["original"] };
		api.registerMcpServer("active", config);
		config.args.push("changed");
		expect(runtime.mcpServers.list()[0].config).toEqual({ command: "first", args: ["original"] });
		api.unregisterMcpServer("active");
		expect(runtime.mcpServers.list()).toEqual([]);
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it("notifies when a public registry caller registers the same object again", () => {
		const { runtime } = setup();
		const changed = vi.fn();
		runtime.mcpServers.setChangeListener(changed);
		runtime.mcpServers.register({ name: "public", config: { command: "first" }, extensionPath: "<owner>" });
		const server = runtime.mcpServers.get("public")!;
		server.config = { command: "updated" };
		runtime.mcpServers.register(server);
		expect(runtime.mcpServers.list()[0].config).toEqual({ command: "updated" });
		expect(changed).toHaveBeenCalledTimes(2);
		runtime.mcpServers.unregister("public", "<other>");
		runtime.mcpServers.unregister("missing", "<owner>");
		expect(changed).toHaveBeenCalledTimes(2);
	});
});
