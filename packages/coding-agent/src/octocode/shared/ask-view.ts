import type { ExtensionUIAskView } from "../../core/features/types.ts";

/**
 * The render projection of a `Question` (`ask/question.ts` `viewOf`): the card `card.ts` draws for askUser's questions and
 * the harness's permission prompts. A card over a selector has the selector's labels as its options.
 */
export type AskView = ExtensionUIAskView;

/** The suffix askUser's description asks the model to put on its recommended option. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i;
export const isRecommended = (label: string): boolean => RECOMMENDED.test(label);

/** Body lines a collapsible body shows until expanded. */
export const PREVIEW_LINES = 3;
