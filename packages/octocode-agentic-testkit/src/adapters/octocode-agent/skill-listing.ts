import type { Skill } from "../../agents/inproc.ts";

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
	"&#39;": "'",
};
const unescape = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m);

/** The `<skill name="…">description</skill>` entries of a captured system prompt, descriptions unescaped. */
export function parseSkillListing(systemPrompt: string): Pick<Skill, "name" | "description">[] {
	const out: Pick<Skill, "name" | "description">[] = [];
	for (const m of systemPrompt.matchAll(/<skill name="([^"]+)">\s*([\s\S]*?)\s*<\/skill>/g))
		out.push({ name: m[1], description: unescape(m[2]) });
	return out;
}
