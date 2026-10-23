import { fencedParts } from "../shared/fence.ts";
import { contentText } from "../shared/util.ts";
import type { ResultDetails } from "./run-types.ts";

/** Semantic report shared by terminal and browser adapters; neither interface parses the other's rendered output. */
export function presentAgentReport(content: unknown, details: Partial<ResultDetails> = {}) {
	const [head = "", ...rest] = contentText(content).split("\n");
	const text = rest.join("\n");
	const fenced = fencedParts(text);
	const body = fenced ? (fenced.footer ? `${fenced.body}\n\n${fenced.footer}` : fenced.body) : text;
	return {
		id: details.id,
		goal: details.goal,
		status: details.status,
		summary: details.summary ?? head,
		body,
		files: [details.session?.file, details.notices?.file].filter((file): file is string => Boolean(file)),
	};
}
