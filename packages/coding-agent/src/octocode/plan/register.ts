import { builtinDescription } from "../../core/slash-commands.ts";
import { contentText } from "@octocodeai/octocode-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/features/index.ts";
import { getApplicationPortForSession } from "../../core/application/index.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { planningRefusal, type ShellReader } from "./gate.ts";
import { getMcpSessionStatus } from "../../../../mcp/src/status.ts";
import { planStartupRequested } from "./startup.ts";
import { PLAN_ENTRY, readPlan, bindPlanConstraint, type PlanOptions, type PlanState } from "../../core/plan-state.ts";
import { approvedPlanPrompt, PLAN_REMINDER_TYPE, planReminder, PLANNING_INSTRUCTIONS } from "./prompts.ts";

/** User controls are commands, never model tools. Plan text lives in branch-aware custom entries. */
export function registerPlanning(api: ExtensionAPI, commands: Subcommands, stopWork: () => Promise<void>) {
	let state: PlanState = { active: false, revision: 0, text: "" };
	let transitioning = false;
	const blocked = () => transitioning || state.active;
	let unbind: (() => void) | undefined;
	api.on("session_shutdown", async () => {
		unbind?.();
	});
	const display = (ctx: ExtensionContext) =>
		ctx.ui.setStatus("plan", state.active ? `Plan · revision ${state.revision}` : undefined);
	const write = (next: PlanState, ctx: ExtensionContext) => {
		api.appendEntry(PLAN_ENTRY, { version: 1, ...next });
		state = next;
		display(ctx);
	};
	const restore = (ctx: ExtensionContext) => {
		state = readPlan(ctx.sessionManager.getBranch());
		display(ctx);
	};
	const ensureState = (ctx: ExtensionContext) => {
		if (unbind) return;
		restore(ctx);
		unbind = bindPlanConstraint(ctx.sessionManager.getSessionId(), blocked);
	};
	api.on("session_start", async (_event, ctx) => {
		restore(ctx);
		unbind?.();
		unbind = bindPlanConstraint(ctx.sessionManager.getSessionId(), blocked);
		if (_event.reason === "startup" && planStartupRequested() && !state.active) write({ ...state, active: true }, ctx);
	});
	api.on("session_tree", async (_event, ctx) => restore(ctx));
	api.on("before_agent_start", async (event, ctx) => {
		ensureState(ctx);
		if (!blocked()) {
			delete event.systemPromptOptions.sections.planning;
			return;
		}
		event.systemPromptOptions.sections.planning = PLANNING_INSTRUCTIONS;
	});
	// The summary may drop the plan's wording: put the current revision back at the tail, outside the cached prefix.
	api.on("session_compact", async (_event, ctx) => {
		ensureState(ctx);
		if (!state.active || !state.text) return;
		try {
			void api.sendMessage(
				{ customType: PLAN_REMINDER_TYPE, content: planReminder(state), display: false },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		} catch {
			// The session was replaced.
		}
	});
	api.on("agent_end", async (event, ctx) => {
		if (!state.active || transitioning) return;
		const last = event.messages.findLast((message) => message.role === "assistant");
		if (last?.role !== "assistant" || last.stopReason !== "stop") return;
		const text = contentText(last.content).trim();
		if (text) write({ active: true, revision: state.revision + 1, text }, ctx);
	});
	const control = async (options: PlanOptions, ctx: ExtensionCommandContext): Promise<void> => {
		if (transitioning) throw new Error("A planning transition is already in progress.");
		ensureState(ctx);
		if (options.action === "show") return;
		if (options.action === "approve" && (!state.active || !state.text || options.revision !== state.revision))
			throw new Error("The plan revision changed or is unavailable. Review /plan and approve that revision.");
		if (options.action === "enter" && state.active) return;
		transitioning = true;
		try {
			// Block new calls before draining existing work. Cancellation owners finish before the state is announced.
			const application = getApplicationPortForSession(ctx.sessionManager.getSessionId());
			const idle = application ? application.invoke("stopActiveWork") : (ctx.abort(), ctx.waitForIdle());
			await Promise.all([idle, stopWork()]);
			write({ ...state, active: options.action === "enter" }, ctx);
		} finally {
			transitioning = false;
		}
	};
	commands.add("plan", {
		description: builtinDescription("plan"),
		argumentHint: "[description|--off|--approve <revision>]",
		dialog: "interaction",
		complete: (prefix) => wordCompletions(["--off", "--approve"], prefix),
		handler: async (args, ctx) => {
			ensureState(ctx);
			if (args === "--show") {
				/* Inspection leaves the constraint unchanged. */
			} else if (args === "--off") await control({ action: "leave" }, ctx);
			else if (args.startsWith("--approve")) {
				if (!/^--approve [1-9]\d*$/.test(args)) return say(ctx, "Usage: /plan --approve <revision>", "warning");
				const approved = { ...state };
				await control({ action: "approve", revision: Number(args.split(" ")[1]) }, ctx);
				api.sendUserMessage(approvedPlanPrompt(approved), {
					expandPromptTemplates: false,
				});
			} else {
				if (args.startsWith("--"))
					return say(ctx, "Usage: /plan [description|--show|--off|--approve <revision>]", "warning");
				if (args.length > 8000) return say(ctx, "Plan descriptions must be at most 8000 characters.", "warning");
				await control({ action: "enter" }, ctx);
				if (args) api.sendUserMessage(args, { expandPromptTemplates: false });
			}
			say(
				ctx,
				`Planning ${state.active ? "active" : "off"}; revision ${state.revision}. Underlying permission mode is unchanged.\n${state.text || "No plan written yet."}`,
			);
		},
	});
	const planning = {
		/** The host's read-only shell classifier (the permission layer depends on this module, so it cannot import it); unset, plan mode blocks every shell command. */
		readOnlyShell: undefined as ShellReader | undefined,
		blocked,
		control,
		gate: (event: Parameters<typeof planningRefusal>[0]) => {
			if (!blocked()) return undefined;
			const reason = planningRefusal(
				event,
				api.getAllTools().find((tool) => tool.name === event.toolName),
				getMcpSessionStatus(api.events),
				planning.readOnlyShell,
			);
			return reason ? { block: true, reason } : undefined;
		},
	};
	return planning;
}
