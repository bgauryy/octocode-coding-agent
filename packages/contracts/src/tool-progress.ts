import { Type, type Static } from "typebox";

/** How far a running tool is: `progress` grows, `total` is set when the amount of work is known. */
export const ApplicationToolProgressSchema = Type.Object({
	progress: Type.Number({ minimum: 0 }),
	total: Type.Optional(Type.Number({ minimum: 0 })),
	message: Type.Optional(Type.String({ maxLength: 1000 })),
});
export type ApplicationToolProgress = Static<typeof ApplicationToolProgressSchema>;

/** The completed share of the work, from 0 to 1; undefined when the total is unknown. */
export function toolProgressFraction(progress: ApplicationToolProgress): number | undefined {
	if (progress.total === undefined || progress.total <= 0) return undefined;
	return Math.min(1, Math.max(0, progress.progress / progress.total));
}

/** One line every surface shows for a tool's progress: `3/10 (30%) · message`, or `3 · message` without a total. */
export function toolProgressText(progress: ApplicationToolProgress): string {
	const fraction = toolProgressFraction(progress);
	const amount =
		fraction === undefined
			? `${progress.progress}`
			: `${progress.progress}/${progress.total} (${Math.floor(fraction * 100)}%)`;
	return progress.message ? `${amount} · ${progress.message}` : amount;
}
