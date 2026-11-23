import { Type, type Static } from "typebox";
import { StringEnum } from "./schema.ts";
import { UiStateSchema } from "./tool-display.ts";

/**
 * What an agent or a session is doing, as its light shows it: `working` (a run, compaction, a retry, background work or a
 * wake), `waiting` (a dialog or question waits for the user), `error` (the job failed or stopped with work left open) and
 * `idle` (nothing runs; done, or a timer that will wake it). The projections' `activity(facts)` is the one mapping.
 */
export const ACTIVITY_TONES = ["working", "waiting", "error", "idle"] as const;
const ActivityToneSchema = StringEnum(ACTIVITY_TONES);
export type ActivityTone = Static<typeof ActivityToneSchema>;

/** A light as a surface receives it: the tone, the design state whose mark draws it, and the words printed beside it. */
export const ActivitySchema = Type.Object(
	{ tone: ActivityToneSchema, state: UiStateSchema, label: Type.String({ minLength: 1, maxLength: 64 }) },
	{ additionalProperties: false },
);
export type Activity = Static<typeof ActivitySchema>;
