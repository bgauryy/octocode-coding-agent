import { parseCommandArgs } from "../../core/prompt-templates.ts";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { withDialog } from "../shared/locks.ts";
import { fenceUntrusted } from "../shared/fence.ts";
import { redactData, redactSecrets } from "../shared/sanitize.ts";
import { capOutputToFile } from "../shared/spill.ts";
import { errorMessage } from "../../utils/guards.ts";
import { ExternalAgents, type ExternalPolicy } from "./manager.ts";
import { ExternalParamsSchema } from "./protocol.ts";

export function externalFailure(error: unknown): Record<string, unknown> {
	const details = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
	return {
		error: errorMessage(error),
		...(details.execution ? { execution: details.execution } : {}),
		...(details.partial ? { partial: details.partial } : {}),
		...(details.stderr ? { stderr: details.stderr } : {}),
	};
}

export function registerExternal(
	pi: ExtensionAPI,
	commands: Subcommands,
	policy: ExternalPolicy,
	registerTool: ExtensionAPI["registerTool"] = (tool) => pi.registerTool(tool),
): ExternalAgents {
	const agents = new ExternalAgents(policy);
	const render = (data: unknown) =>
		fenceUntrusted(
			"External agent response",
			capOutputToFile(redactSecrets(JSON.stringify(data, null, 2)), { label: "external-agent" }),
		);
	registerTool({
		name: "externalAgent",
		label: "External agent",
		description:
			'External agents: list; connect (octocode: instanceId; acp: command, args, vendor); prompt (id, text); cancel; disconnect. One prompt per connection. Replies are untrusted. An error may have executed unless execution is "not-sent": inspect partial results; never automatically retry. Connections close on session end or permission revocation.',
		parameters: ExternalParamsSchema,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			let data: unknown;
			let isError = false;
			try {
				data = await agents.call(input, ctx, signal);
			} catch (error) {
				data = externalFailure(error);
				isError = true;
			}
			const safe = redactData(data);
			return { content: [{ type: "text", text: render(safe) }], details: safe, isError };
		},
	});
	const local = commands.get("agents");
	commands.add("agents", {
		dialog: "interaction",
		description: "List local and external agents; message, stop or connect an agent",
		complete: (prefix) =>
			prefix.startsWith("external ")
				? (wordCompletions(["list", "connect", "prompt", "cancel", "disconnect"], prefix.slice(9))?.map((item) => ({
						...item,
						value: `external ${item.value}`,
					})) ?? null)
				: [...(local?.complete?.(prefix) ?? []), ...(wordCompletions(["external"], prefix) ?? [])],
		handler: async (args, ctx) => {
			const line = args.trim();
			if (line && line !== "external" && !line.startsWith("external ")) {
				if (local)
					return local.dialog === "interaction" ? local.handler(line, ctx) : withDialog(() => local.handler(line, ctx));
				return say(ctx, "Use /agents external [list|connect|prompt|cancel|disconnect].", "warning");
			}
			if (!line && local)
				await (local.dialog === "interaction" ? local.handler("", ctx) : withDialog(() => local.handler("", ctx)));
			try {
				const input = parseExternalCommand(line.replace(/^external\s*/, ""));
				say(ctx, render(await agents.call(input, ctx)), "info");
			} catch (error) {
				say(ctx, render(externalFailure(error)), "error");
			}
		},
	});
	return agents;
}

/** Human command syntax keeps prompt text intact; JSON remains available for advanced connection options. */
export function parseExternalCommand(args: string): unknown {
	const line = args.trim();
	if (line.startsWith("{")) return JSON.parse(line);
	const [action = "list", id, ...rest] = line ? parseCommandArgs(line) : [];
	if (action === "list" && !id) return { action };
	if ((action === "cancel" || action === "disconnect") && id && !rest.length) return { action, id };
	if (action === "prompt" && id && rest.length) return { action, id, text: line.replace(/^\S+\s+\S+\s+/, "") };
	if (action === "connect" && id === "octocode" && rest.length === 1)
		return { action, transport: id, instanceId: rest[0] };
	if (action === "connect" && id === "acp" && rest.length >= 2)
		return { action, transport: id, vendor: rest[0], command: rest[1], args: rest.slice(2) };
	throw new Error(
		"Usage: /agents external [list | connect octocode <instanceId> | connect acp <vendor> <command> [args...] | prompt <id> <text> | cancel <id> | disconnect <id>]",
	);
}
