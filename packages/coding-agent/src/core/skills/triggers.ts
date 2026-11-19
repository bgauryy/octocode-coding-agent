import type { ResourceDiagnostic } from "../diagnostics.ts";

/** Most trigger words one skill may declare; the rest are ignored. */
const MAX_SKILL_TRIGGERS = 64;

/**
 * The words in a skill's `metadata.triggers`: a list of strings that point the prompt editor's highlight at the skill.
 * Anything else (a string, a list holding non-strings) is ignored with a warning, as the other frontmatter fields are.
 */
export function skillTriggers(
	metadata: unknown,
	path: string,
): { triggers?: string[]; diagnostic?: ResourceDiagnostic } {
	if (!metadata || typeof metadata !== "object") return {};
	const value = (metadata as Record<string, unknown>).triggers;
	if (value === undefined) return {};
	if (!Array.isArray(value) || !value.every((word) => typeof word === "string")) {
		return { diagnostic: { type: "warning", message: "metadata.triggers must be a list of strings; ignored", path } };
	}
	const triggers = value
		.map((word) => word.trim())
		.filter(Boolean)
		.slice(0, MAX_SKILL_TRIGGERS);
	return triggers.length > 0 ? { triggers } : {};
}
