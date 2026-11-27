import type { FeatureContext } from "../../coding-agent/src/core/features/types.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { registerMcpHost } from "../src/index.ts";
import type { McpServerEntry } from "../src/config.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import { defaultPreset } from "./mcp-default-preset.ts";
import type { McpFeatureOptions } from "../src/options.ts";
import { StdioTransport } from "../src/client/index.ts";
import { createDefaultTransport } from "../src/runtime.ts";
import { fakeCtx, fakeHost } from "../../coding-agent/test/octocode/fake-host.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

/** Runs the production host's lifecycle and tool registry against isolated stdio fixtures. */
export function mcpHost(
	options: McpFeatureOptions & { cwd?: string; servers?: McpServerEntry[]; hasUI?: boolean } = {},
) {
	const fake = fakeHost();
	Object.assign(fake.api, { channels: createEventBus() });
	fake.api.mcpServers.list = () => [];
	fake.api.renderers.tool = () => {};
	fake.api.tools.getActive = () =>
		[...fake.tools.values()]
			.filter((tool) => tool.exposure !== "hidden" && tool.defaultActive !== false)
			.map((tool) => tool.name);
	const ctx = fakeCtx({ cwd: options.cwd ?? tmp(), hasUI: options.hasUI ?? true });
	const transports: StdioTransport[] = [];
	const state = registerMcpHost(fake.api, {
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		logPath: `${tmp()}/mcp.log`,
		loadConfig: (_ctx, defaults) => ({ servers: options.servers ?? [...defaults], errors: [] }),
		presets: [defaultPreset({})],
		createTransport: (entry, cwd, auth) => {
			const transport = createDefaultTransport(entry, cwd, auth);
			if (transport instanceof StdioTransport) transports.push(transport);
			return transport;
		},
		...options,
	});
	// As the host does: `session_start`, then resource discovery, which lets the startup connections launch.
	const start = async (context: FeatureContext = ctx) => {
		await fake.fire("session_start", {}, context);
		await fake.fire("resources_discover", { type: "resources_discover", cwd: context.cwd, reason: "startup" }, context);
	};
	const prompt = async (context: FeatureContext = ctx) => {
		const event = {
			systemPromptOptions: { sections: {} as Record<string, string>, baseSections: {} as Record<string, string> },
		};
		await fake.fire("before_agent_start", event, context);
		// Generated server files land in the tool-stable base sections; the session's own sections follow them.
		return { ...event.systemPromptOptions.baseSections, ...event.systemPromptOptions.sections };
	};
	const call = (
		name: string,
		args: Record<string, unknown> = {},
		signal?: AbortSignal,
		update?: (result: unknown) => void,
	) => fake.tools.get(name).execute("test-call", args, signal, update, ctx);
	const close = () => fake.fire("session_shutdown", {}, ctx);
	return { ...fake, ctx, state, transports, start, prompt, call, close };
}
