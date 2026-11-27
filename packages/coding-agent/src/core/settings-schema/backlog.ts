import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** The `backlog` settings; `backlog/qa-gate.ts` is the one reader of `qa`. */
export const BacklogSettingsSchema = Type.Object(
	{
		qa: Type.Optional(
			Type.Union([Type.Literal("important"), Type.Literal("all"), Type.Literal("off")], {
				description:
					"Which items a small reviewer model checks before `backlog done` completes them. `important`: p0 and p1 features and bugs. `all`: every item except epics. `off`: none. A reviewer that finds a defect returns the item to ongoing, or to the backlog when evidence is missing, with its findings noted; without a priced small model the item completes with a note. Each review costs a small-model run.",
				default: SETTINGS_DEFAULTS.backlog.qa,
			}),
		),
		compactOnDone: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 1,
				description:
					"Floor on the share of the room before automatic compaction that the history (the context less the system prompt and tool declarations) must have reached before `backlog done` may compact the main session's context; it limits how often this runs, and a cost check limits losses: the compaction runs only when the requests the session still expects for its own open items repay the summary. The summary keeps the finished items in focus. `0` turns it off. Subagents never compact this way.",
				default: SETTINGS_DEFAULTS.backlog.compactOnDone,
			}),
		),
	},
	{ additionalProperties: false },
);
