import type { AskView } from "../../core/features/types.ts";

/**
 * The render projection of a `Question` (`ask/question.ts` `viewOf`): the card `card.ts` draws for askUser's questions and
 * the harness's permission prompts. A card over a selector has the selector's labels as its options.
 */
export type { AskView };

/** The suffix askUser's description asks the model to put on its recommended option. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i;
export const isRecommended = (label: string): boolean => RECOMMENDED.test(label);

/** The label as a person reads it: without the `(Recommended)` suffix, which the ★ stands for. */
const plainLabel = (label: string): string => label.replace(RECOMMENDED, "");

/** The countdown line a card shows: what is taken when the time runs out, and in how many seconds. */
export const countdownText = (labels: readonly string[], seconds: number): string =>
	`auto: ${labels.map(plainLabel).join(", ")} in ${Math.max(0, seconds)}s`;

/** Body lines a collapsible body shows until expanded. */
export const PREVIEW_LINES = 3;
