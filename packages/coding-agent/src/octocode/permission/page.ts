import type { CommandContext } from "../../core/features/index.ts";
import { showCommandPage } from "../shared/page.ts";
import { modeSummary } from "./ask/text.ts";
import { CHOOSABLE_MODES, type PermissionMode } from "./mode.ts";

/** What the user picked on the `/permissions` page; `undefined` when they left it. */
export type PermissionsChoice = { mode: PermissionMode } | { open: "grants" | "log" | "status" | "plan" };

const OPEN_ROWS: ReadonlyArray<readonly [id: "status" | "grants" | "log" | "plan", name: string, detail: string]> = [
	["status", "Decisions per action", "what each mode allows, asks and denies"],
	["grants", "Session grants", "what this session may do without asking again"],
	["log", "Decision log", "every permission decision of this session"],
	["plan", "Planning", "the independent read-only constraint"],
];

export interface PermissionsPageState {
	mode: PermissionMode;
	grants: number;
	planning: boolean;
	/** Whether `/permissions plan` can be offered. */
	canPlan: boolean;
}

/** The `/permissions` list page: the modes a session can switch to, then the views of what the mode decided. */
export async function pickPermissionsAction(
	state: PermissionsPageState,
	ctx: Pick<CommandContext, "ui">,
): Promise<PermissionsChoice | undefined> {
	const choice = await showCommandPage(ctx.ui, {
		title: "Permissions",
		facts: [{ label: "Mode", value: `${state.mode} — ${modeSummary(state.mode)}` }],
		initialId: state.mode,
		enter: "open",
		sections: [
			{
				heading: "Switch mode",
				rows: CHOOSABLE_MODES.map((mode) => ({
					id: `mode:${mode}`,
					name: mode,
					detail: mode === state.mode ? "current" : "",
					...(mode === state.mode ? { badge: "on", tone: "success" as const } : {}),
				})),
			},
			{
				heading: "See",
				rows: OPEN_ROWS.filter(([id]) => id !== "plan" || state.canPlan).map(([id, name, detail]) => ({
					id: `open:${id}`,
					name,
					detail:
						id === "grants"
							? `${state.grants} now · ${detail}`
							: id === "plan"
								? `${state.planning ? "active" : "off"} · ${detail}`
								: detail,
				})),
			},
		],
		notes: ["Modes decide what Octocode asks about and records; they are not a sandbox."],
	});
	if (!choice) return undefined;
	const [kind, value] = choice.id.split(":");
	if (kind === "mode") return { mode: value as PermissionMode };
	return { open: value as "grants" | "log" | "status" | "plan" };
}
