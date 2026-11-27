import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { createFeatureRuntime, loadFeatureFromFactory } from "./helpers/features.ts";
import type { FeatureSetup, FeatureRegister } from "../src/core/features/types.ts";

function setup() {
	const runtime = createFeatureRuntime();
	const events = createEventBus();
	return {
		runtime,
		load: (name: string, factory: FeatureRegister) =>
			loadFeatureFromFactory(factory, process.cwd(), events, runtime, name),
	};
}

describe("extension MCP registration transactions", () => {
	it("rejects namespace aliases within one factory without committing its other changes", async () => {
		const { runtime, load } = setup();
		await expect(
			load("<collision>", (api) => {
				api.providers.register("collision", { baseUrl: "https://example.invalid" });
				api.mcpServers.register("alpha-beta", { command: "first" });
				api.mcpServers.register("alpha_beta", { command: "second" });
			}),
		).rejects.toThrow('MCP server "alpha_beta" conflicts with registered server "alpha-beta"');
		expect(runtime.mcpServers.list()).toEqual([]);
		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});

	it("lets another extension's registration replace an inherited server, whatever the load order", async () => {
		const { runtime, load } = setup();
		await load("builtin:mcp", (api) => api.mcpServers.register("shared", { command: "parent" }, { inherited: true }));
		await load("<plugin>", (api) => api.mcpServers.register("shared", { command: "own" }));
		expect(runtime.mcpServers.list()).toEqual([{ name: "shared", config: { command: "own" }, source: "<plugin>" }]);

		await load("<late>", (api) => api.mcpServers.register("shared2", { command: "own" }));
		await load("builtin:mcp", (api) => api.mcpServers.register("shared2", { command: "parent" }, { inherited: true }));
		expect(runtime.mcpServers.get("shared2")?.source).toBe("<late>");
		await expect(load("<other>", (api) => api.mcpServers.register("shared2", { command: "x" }))).rejects.toThrow(
			'MCP server "shared2" is already registered by feature "<late>"',
		);
	});

	it("revalidates every change before committing when another factory claimed a name", async () => {
		const { runtime, load } = setup();
		let resume!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const slow = load("<slow>", async (api) => {
			api.providers.register("slow", { baseUrl: "https://example.invalid" });
			api.mcpServers.register("unrelated", { command: "slow" });
			api.mcpServers.register("claimed", { command: "slow" });
			await waiting;
		});
		await load("<winner>", (api) => api.mcpServers.register("claimed", { command: "winner" }));
		resume();
		await expect(slow).rejects.toThrow('MCP server "claimed" is already registered by feature "<winner>"');
		expect(runtime.mcpServers.list()).toEqual([{ name: "claimed", config: { command: "winner" }, source: "<winner>" }]);
		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});

	it("merges nonconflicting concurrent factories and keeps their registrations", async () => {
		const { runtime, load } = setup();
		let resume!: () => void;
		const waiting = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const slow = load("<slow>", async (api) => {
			api.mcpServers.register("slow", { command: "slow" });
			await waiting;
		});
		await load("<fast>", (api) => api.mcpServers.register("fast", { command: "fast" }));
		resume();
		await slow;
		expect(runtime.mcpServers.list().map(({ name }) => name)).toEqual(["fast", "slow"]);
	});

	it("preserves same-owner replacement", async () => {
		const { runtime, load } = setup();
		await load("<owner>", (api) => {
			api.mcpServers.register("alpha-beta", { command: "first" });
			api.mcpServers.register("alpha-beta", { command: "replacement" });
		});
		expect(runtime.mcpServers.list()).toEqual([
			{ name: "alpha-beta", config: { command: "replacement" }, source: "<owner>" },
		]);
	});

	it("rejects another owner's registration in a namespace already taken", async () => {
		const { runtime, load } = setup();
		await load("<owner>", (api) => api.mcpServers.register("alpha-beta", { command: "owner" }));
		await expect(
			load("<other>", (api) => {
				api.mcpServers.register("alpha_beta", { command: "other" });
			}),
		).rejects.toThrow('MCP server "alpha_beta" conflicts with registered server "alpha-beta"');
		expect(runtime.mcpServers.list()[0].config).toEqual({ command: "owner" });
	});

	it("keeps active API changes immediate and snapshots caller-owned configurations", async () => {
		const { runtime, load } = setup();
		let api!: FeatureSetup;
		await load("<owner>", (value) => {
			api = value;
		});
		const changed = vi.fn();
		runtime.mcpServers.setChangeListener(changed);
		const config = { command: "first", args: ["original"] };
		api.mcpServers.register("active", config);
		config.args.push("changed");
		expect(runtime.mcpServers.list()[0].config).toEqual({ command: "first", args: ["original"] });
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("notifies when a public registry caller registers the same object again", () => {
		const { runtime } = setup();
		const changed = vi.fn();
		runtime.mcpServers.setChangeListener(changed);
		runtime.mcpServers.register({ name: "public", config: { command: "first" }, source: "<owner>" });
		const server = runtime.mcpServers.get("public")!;
		server.config = { command: "updated" };
		runtime.mcpServers.register(server);
		expect(runtime.mcpServers.list()[0].config).toEqual({ command: "updated" });
		expect(changed).toHaveBeenCalledTimes(2);
	});
});
