/**
 * An absolute size class for a model whose price is unknown (a custom, `models.json` or plan model priced 0), so a
 * purpose can still be routed. It is a guess from the id's family name, then the output limit and context window, and
 * every route that rests on it says so.
 */
export type SizeClass = "small" | "medium" | "large";

export const SIZE_RANK: Record<SizeClass, number> = { small: 0, medium: 1, large: 2 };

/** Id parts that name a cheap, fast tier (`haiku`, `gpt-5-mini`, `gemini-flash`, `nano`). */
const SMALL_ID = /(^|[^a-z])(haiku|mini|flash|nano|lite|small|tiny|instant|air|fast)([^a-z]|$)/i;
/** Id parts that name a vendor's top tier (`opus`, `gemini-pro`, `max`, `ultra`, `large`). */
const LARGE_ID = /(^|[^a-z])(opus|pro|max|ultra|large|reasoner)([^a-z]|$)/i;
/** Below these an unnamed model is a small one. */
const SMALL_CONTEXT = 200_000;
const SMALL_OUTPUT = 8_192;

export interface SizeFacts {
	id: string;
	context?: number;
	output?: number;
}

/**
 * The id family decides first (a small-tier word wins over a top-tier one), then a small output limit or a short
 * window means small; anything else is medium. Never large unless the id says so.
 */
export function guessSizeClass({ id, context, output }: SizeFacts): SizeClass {
	const name = id.slice(id.lastIndexOf("/") + 1);
	if (SMALL_ID.test(name)) return "small";
	if (LARGE_ID.test(name)) return "large";
	if (output !== undefined && output <= SMALL_OUTPUT) return "small";
	if (context !== undefined && context < SMALL_CONTEXT) return "small";
	return "medium";
}
