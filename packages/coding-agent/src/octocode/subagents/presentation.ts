import { fencedParts } from "../shared/fence.ts";
import { contentText } from "../shared/util.ts";
import type { ResultDetails } from "./run-types.ts";

/** Semantic report shared by terminal and browser adapters; neither interface parses the other's rendered output. */
export function presentAgentReport(content: unknown, details: Partial<ResultDetails> = {}) {
	const [head = "", ...rest] = contentText(content).split("\n");
	const text = rest.join("\n");
	const fenced = fencedParts(text);
	let body = fenced ? (fenced.footer ? `${fenced.body}\n\n${fenced.footer}` : fenced.body) : text;
	const result = details.structured;
	if (result) {
		// Machine data stays in the durable report. Adapters show the host's verdict, not a truncated JSON value.
		body = body
			.split(/(?:^|\n)Structured result:/, 1)[0]
			.trimEnd()
			.slice(0, 16000);
		body += `\n\nStructured result: ${result.status}${result.error ? ` (${result.error.code})` : ""}.`;
	}
	return {
		id: details.id,
		goal: details.goal,
		status: details.status,
		outcome: details.outcome,
		summary: result ? (details.summary ?? head).slice(0, 1000) : (details.summary ?? head),
		body,
		...(result
			? {
					structured: {
						version: result.version,
						schemaHash: result.schemaHash,
						status: result.status,
						...(result.error ? { error: result.error } : {}),
					},
				}
			: {}),
		files: [details.session?.file, details.notices?.file].filter((file): file is string => Boolean(file)),
	};
}
