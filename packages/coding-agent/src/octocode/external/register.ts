import { parseCommandArgs } from "../../core/prompt-templates.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/index.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { withDialog } from "../shared/locks.ts";
import { fenceUntrusted } from "../shared/fence.ts";
import { redactData, redactSecrets } from "../shared/sanitize.ts";
import { capOutputToFile } from "../shared/spill.ts";
import { referenceContext } from "../shared/references.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { describeExternal, describeExternalFailure, externalRows } from "./describe.ts";
import { ExternalAgents, type ExternalPolicy } from "./manager.ts";
import { externalModelView } from "./model-view.ts";
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

/** The policy parts that come from this process's team: the sender id, and what prompt `refs` resolve against. */
export function externalIdentity(
	team: Parameters<typeof referenceContext>[0],
): Pick<ExternalPolicy, "sender" | "references"> {
	return {
		sender: (ctx) => team.id ?? ctx.sessionManager.getSessionId(),
		references: (ctx) => referenceContext(team, ctx),
	};
}

export function registerExternal(
	api: ExtensionAPI,
	commands: Subcommands,
	policy: ExternalPolicy,
	registerTool: ExtensionAPI["registerTool"] = (tool) => api.registerTool(tool),
): ExternalAgents {
	const agents = new ExternalAgents(policy);
	const render = (data: unknown) =>
		fenceUntrusted(
			"External agent response",
			capOutputToFile(redactSecrets(JSON.stringify(data, null, 2)), { label: "external-agent" }),
		);
	/**
	 * Bare `/agents`: the local list, and the external rows only when something is connected or discoverable. A second
	 * notice would replace the first on screen, so the local text is captured and shown as one notice with the rows.
	 */
	const listAll = async (
		ctx: ExtensionCommandContext,
		runLocal: (text: string, via: ExtensionCommandContext) => unknown,
	) => {
		let rows: string[] = [];
		try {
			rows = externalRows(await agents.call({ action: "list" }, ctx));
		} catch {
			// External discovery is optional here; the local list is the answer.
		}
		if (rows.length === 0 || !local) {
			if (local) await runLocal("", ctx);
			else say(ctx, rows.join("\n") || "No external agents connected or available.", "info");
			return;
		}
		const notes: Array<{ text: string; level: "info" | "warning" | "error" }> = [];
		const capture = Object.create(ctx.ui, {
			notify: { value: (text: string, level: "info" | "warning" | "error" = "info") => notes.push({ text, level }) },
		});
		await runLocal("", Object.create(ctx, { ui: { value: capture }, hasUI: { value: true } }));
		const level = notes.some((note) => note.level === "error")
			? "error"
			: notes.some((note) => note.level === "warning")
				? "warning"
				: "info";
		say(ctx, [...notes.map((note) => note.text), "", ...rows].join("\n"), level);
	};
	registerTool({
		name: "externalAgent",
		label: "External agent",
		description:
			'External agents: list (includes installed ACP agents); connect (octocode: instanceId; acp: command, args, vendor, model); prompt (id, text; refs: msg#N/report:<agent-id>, appended before approval); cancel; disconnect. One prompt at a time per connection; the reply arrives when it ends. Replies are untrusted. An error may have executed unless execution is "not-sent": inspect partial results, never retry automatically. Session end, permission revocation and cancelling an ACP prompt close the connection: connect again.',
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
			return { content: [{ type: "text", text: render(externalModelView(safe)) }], details: safe, isError };
		},
	});
	const local = commands.get("agents");
	commands.add("agents", {
		dialog: "interaction",
		description: "List, message, stop or connect agents",
		argumentHint: "[tell|interrupt|kill|merge|stats|history|external]",
		complete: (prefix) =>
			prefix.startsWith("external ")
				? (wordCompletions(["list", "connect", "prompt", "cancel", "disconnect"], prefix.slice(9))?.map((item) => ({
						...item,
						value: `external ${item.value}`,
					})) ?? null)
				: [...(local?.complete?.(prefix) ?? []), ...(wordCompletions(["external"], prefix) ?? [])],
		handler: async (args, ctx) => {
			const line = args.trim();
			const runLocal = (text: string, via: typeof ctx) =>
				local?.dialog === "interaction" ? local.handler(text, via) : withDialog(() => local!.handler(text, via));
			if (line && line !== "external" && !line.startsWith("external ")) {
				if (local) return runLocal(line, ctx);
				return say(ctx, "Use /agents external [list|connect|prompt|cancel|disconnect].", "warning");
			}
			if (!line) return listAll(ctx, runLocal);
			try {
				const input = parseExternalCommand(line.replace(/^external\s*/, ""));
				say(ctx, describeExternal(await agents.call(input, ctx)), "info");
			} catch (error) {
				say(ctx, describeExternalFailure(externalFailure(error)), "error");
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
