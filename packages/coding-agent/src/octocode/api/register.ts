import type { ExtensionAPI } from "../../core/features/index.ts";
import { notify, type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { AgentDirectory, ApiOperations } from "./bridge/contracts.ts";
import { type ApiOptions, startupOptions, transportsFor } from "./bridge/options.ts";
import { OctocodeApi } from "./bridge.ts";
import { sessionApiEnabled } from "./enabled.ts";
import { apiDir, type InstanceRecord, listInstances } from "./registry.ts";

/** The live API instances on this Octocode home, read without sweeping records: a listing must not change anything. */
export const runningApiInstances = (): InstanceRecord[] => listInstances(apiDir(), false);

/** Wire the external API into Octocode: event publishing, lifecycle and `/api`. Subagents never expose one. */
export function registerApi(
	api: ExtensionAPI,
	commands: Subcommands,
	agents: AgentDirectory,
	version: () => string | undefined,
	operations?: ApiOperations,
): { api: OctocodeApi; start: (ctx: Parameters<OctocodeApi["start"]>[0]) => Promise<void>; stop: () => Promise<void> } {
	const server = new OctocodeApi(api, agents, version, process.env, operations);
	server.observe();
	/** What `/api on` or `/api off` chose: it holds for this process, across `/new` and `/resume`, over the setting. */
	let chosen: { options: ApiOptions | undefined } | undefined;

	commands.add("api", {
		description: "Show, start or stop the local session API",
		argumentHint: "[on [http]|off]",
		complete: (prefix) => wordCompletions(["on", "on http", "off"], prefix),
		handler: async (args, ctx) => {
			const line = args.trim();
			if (line !== "" && !/^(?:on(?:\s+http)?|off)$/.test(line))
				return say(ctx, "Usage: /api [on [http] | off]", "warning");
			const [action, flag] = line.split(/\s+/);
			try {
				if (action === "on") {
					chosen = { options: transportsFor(flag === "http" ? 0 : undefined) };
					await server.start(ctx, chosen.options);
				} else if (action === "off") {
					chosen = { options: undefined };
					await server.stop();
					// stop() unbinds the session; bind again so a later `api on` works.
					await server.start(ctx, undefined);
				}
			} catch (error) {
				say(ctx, errorMessage(error), "error");
				return;
			}
			const info = server.instance;
			say(
				ctx,
				info
					? [
							`Octocode API ${info.id}`,
							info.socket ? `socket: ${info.socket}` : "",
							info.http ? `http: ${info.http.url} (token in the instance file)` : "",
							`Discovery: ${server.directory}/instances/${info.id}.json`,
						]
							.filter(Boolean)
							.join("\n")
					: "Octocode API is off. Start with /api on (/api on http adds loopback HTTP). The sessionApi setting turns it off for new sessions.",
				"info",
			);
		},
	});

	return {
		api: server,
		start: async (ctx) => {
			// A bad environment still binds the session (so `/api on` works) and says why the API is off.
			let options = chosen?.options;
			let failure: unknown;
			try {
				if (!chosen) options = startupOptions(sessionApiEnabled());
			} catch (error) {
				failure = error;
			}
			try {
				await server.start(ctx, options);
			} catch (error) {
				failure = error;
			}
			if (failure === undefined) return;
			// Print and JSON modes have no UI to notify: the reason goes to stderr (see `say`) so a headless run knows why the API is off.
			if (ctx.hasUI) notify(ctx.ui, errorMessage(failure), "warning");
			else process.stderr.write(`${sanitizeTerminalText(errorMessage(failure))}\n`);
		},
		stop: () => server.stop(),
	};
}
