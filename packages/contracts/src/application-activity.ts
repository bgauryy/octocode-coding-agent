import { Type, type Static } from "typebox";
import { ApplicationAssetSchema } from "./content.ts";

/** Portable session notices. Persisted entries and live-only notifications have distinct provenance. */
export const ApplicationActivitySchema = Type.Object({
	id: Type.String(),
	kind: Type.String(),
	at: Type.Number(),
	text: Type.String({ maxLength: 4000 }),
	source: Type.Union([Type.Literal("session"), Type.Literal("live")]),
	entryId: Type.Optional(Type.String()),
	data: Type.Optional(Type.Unknown()),
	full: Type.Optional(ApplicationAssetSchema),
	/** Full activity text when both the text and the structured details exceed their previews. */
	fullText: Type.Optional(ApplicationAssetSchema),
	/** Set when the activity reports a failure; absent otherwise, so older clients still read it as neutral. */
	outcome: Type.Optional(Type.Literal("failed")),
});
export type ApplicationActivity = Static<typeof ApplicationActivitySchema>;
