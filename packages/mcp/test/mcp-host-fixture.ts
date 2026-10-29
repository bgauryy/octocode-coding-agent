import type { ExtensionContext } from "../../coding-agent/src/core/extensions/types.ts";
import { createEventBus } from "../../coding-agent/src/core/event-bus.ts";
import { InMemoryAuthStorageBackend } from "../../coding-agent/src/core/auth-storage.ts";
import { registerMcpHost } from "../src/index.ts";
import type { McpServerEntry } from "../src/config.ts";
import { McpOAuthCredentialStore } from "../src/oauth.ts";
import { octocodePreset } from "../src/presets/octocode/index.ts";
import type { McpExtensionOptions } from "../src/state.ts";
import { StdioTransport } from "../src/client/index.ts";
import { createDefaultTransport } from "../src/runtime.ts";
import { fakeCtx, fakePi } from "../../coding-agent/test/octocode/fake-pi.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

/** Runs the production host's lifecycle and tool registry against isolated stdio fixtures. */
export function mcpHost(
	options: McpExtensionOptions & { cwd?: string; servers?: McpServerEntry[]; hasUI?: boolean } = {},
) {
	const fake = fakePi();
	fake.pi.events = createEventBus();
	fake.pi.getMcpServers = () => [];
	fake.pi.registerToolRenderer = () => {};
	fake.pi.getActiveTools = () =>
		[...fake.tools.values()]
			.filter((tool) => tool.exposure !== "hidden" && tool.defaultActive !== false)
			.map((tool) => tool.name);
	const ctx = fakeCtx({ cwd: options.cwd ?? tmp(), hasUI: options.hasUI ?? true });
	const transports: StdioTransport[] = [];
	const state = registerMcpHost(fake.pi, {
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		logPath: `${tmp()}/mcp.log`,
		loadConfig: (_ctx, defaults) => ({ servers: options.servers ?? [...defaults], errors: [] }),
		presets: [octocodePreset(() => fake.pi.getSkillDirectories(), {})],
		createTransport: (entry, cwd, auth) => {
			const transport = createDefaultTransport(entry, cwd, auth);
			if (transport instanceof StdioTransport) transports.push(transport);
			return transport;
		},
		...options,
	});
	const start = async (context: ExtensionContext = ctx) => {
		await fake.fire("session_start", {}, context);
	};
	const prompt = async (context: ExtensionContext = ctx) => {
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
