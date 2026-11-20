import { builtinDescription } from "../../core/slash-commands.ts";
import { contentText } from "@octocodeai/octocode-ai";
import type { FeatureSetup, CommandContext, FeatureContext } from "../../core/features/index.ts";
import { getApplicationPortForSession } from "../../core/application/index.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { STATUS } from "../shared/status.ts";
import { isStaleSessionError } from "../shared/util.ts";
import { planningRefusal, type ShellReader } from "./gate.ts";
import { getMcpSessionStatus } from "../../../../mcp/src/api.ts";
import { planStartupRequested } from "./startup.ts";
import { PLAN_ENTRY, readPlan, bindPlanConstraint, type PlanOptions, type PlanState } from "../../core/plan-state.ts";
import { approvedPlanPrompt, PLAN_REMINDER_TYPE, planReminder, PLANNING_INSTRUCTIONS } from "./prompts.ts";

/** User controls are commands, never model tools. Plan text lives in branch-aware custom entries. */
export function registerPlanning(api: FeatureSetup, commands: Subcommands, stopWork: () => Promise<void>) {
	let state: PlanState = { active: false, revision: 0, text: "" };
	let transitioning = false;
	const blocked = () => transitioning || state.active;
	let unbind: (() => void) | undefined;
	api.bus.on("session_shutdown", async () => {
		unbind?.();
	});
	const display = (ctx: FeatureContext) =>
		ctx.ui.setStatus(STATUS.plan, state.active ? `plan r${state.revision}` : undefined, "warning");
	const write = (next: PlanState, ctx: FeatureContext) => {
		api.session.appendEntry(PLAN_ENTRY, { version: 1, ...next });
		state = next;
		display(ctx);
	};
	const restore = (ctx: FeatureContext) => {
		state = readPlan(ctx.sessionManager.getBranch());
		display(ctx);
	};
	const ensureState = (ctx: FeatureContext) => {
		if (unbind) return;
		restore(ctx);
		unbind = bindPlanConstraint(ctx.sessionManager.getSessionId(), blocked);
	};
	api.bus.on("session_start", async (_event, ctx) => {
		restore(ctx);
		unbind?.();
		unbind = bindPlanConstraint(ctx.sessionManager.getSessionId(), blocked);
		if (_event.reason === "startup" && planStartupRequested() && !state.active) write({ ...state, active: true }, ctx);
	});
	api.bus.on("session_tree", async (_event, ctx) => restore(ctx));
	api.bus.on("before_agent_start", async (event, ctx) => {
		ensureState(ctx);
		if (!blocked()) {
			delete event.systemPromptOptions.sections.planning;
			return;
		}
		event.systemPromptOptions.sections.planning = PLANNING_INSTRUCTIONS;
	});
	// The summary may drop the plan's wording: put the current revision back at the tail, outside the cached prefix.
	api.bus.on("session_compact", async (_event, ctx) => {
		ensureState(ctx);
		if (!state.active || !state.text) return;
		try {
			await api.session.sendMessage(
				{ customType: PLAN_REMINDER_TYPE, content: planReminder(state), display: false },
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		} catch (error) {
			// The session was replaced; anything else reaches the bus's error report.
			if (!isStaleSessionError(error)) throw error;
		}
	});
	api.bus.on("agent_end", async (event, ctx) => {
		if (!state.active || transitioning) return;
		const last = event.messages.findLast((message) => message.role === "assistant");
		if (last?.role !== "assistant" || last.stopReason !== "stop") return;
		const text = contentText(last.content).trim();
		if (text) write({ active: true, revision: state.revision + 1, text }, ctx);
	});
	const control = async (options: PlanOptions, ctx: CommandContext): Promise<void> => {
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
		argumentHint: "[description|--show|--off|--approve <revision>]",
		dialog: "interaction",
		complete: (prefix) => wordCompletions(["--show", "--off", "--approve"], prefix),
		handler: async (args, ctx) => {
			ensureState(ctx);
			if (args === "--show") {
				/* Inspection leaves the constraint unchanged. */
			} else if (args === "--off") await control({ action: "leave" }, ctx);
			else if (args.startsWith("--approve")) {
				if (!/^--approve [1-9]\d*$/.test(args)) return say(ctx, "Usage: /plan --approve <revision>", "warning");
				const approved = { ...state };
				await control({ action: "approve", revision: Number(args.split(" ")[1]) }, ctx);
				api.session.sendUserMessage(approvedPlanPrompt(approved), {
					expandPromptTemplates: false,
				});
			} else {
				if (args.startsWith("--"))
					return say(ctx, "Usage: /plan [description|--show|--off|--approve <revision>]", "warning");
				if (args.length > 8000) return say(ctx, "Plan descriptions must be at most 8000 characters.", "warning");
				await control({ action: "enter" }, ctx);
				if (args) api.session.sendUserMessage(args, { expandPromptTemplates: false });
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
				api.tools.getAll().find((tool) => tool.name === event.toolName),
				getMcpSessionStatus(api.channels),
				planning.readOnlyShell,
			);
			return reason ? { block: true, reason } : undefined;
		},
	};
	return planning;
}
