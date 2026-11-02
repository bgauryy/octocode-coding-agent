const THINKING_SHORT: Record<string, string> = { minimal: "min", medium: "med" };

/** A thinking level in fewer cells for a narrow row. */
export const shortThinking = (level: string) => THINKING_SHORT[level] ?? level;
