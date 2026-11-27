export interface CitationsDelta {
	title?: string;
	source?: string;
	sourceContent?: { text?: string }[];
	location?: {
		web?: { url?: string };
		documentChar?: { documentIndex?: number; start?: number; end?: number };
		documentPage?: { documentIndex?: number; start?: number; end?: number };
		documentChunk?: { documentIndex?: number };
	};
}
import type { ContentAnnotation } from "../../types.ts";

export function bedrockAnnotation(citation: CitationsDelta): ContentAnnotation {
	const location = citation.location;
	const document = location?.documentChar ?? location?.documentPage ?? location?.documentChunk;
	return {
		type: "citation",
		title: citation.title,
		url: location?.web?.url ?? citation.source,
		text: citation.sourceContent?.map((part) => part.text ?? "").join(""),
		...(document?.documentIndex === undefined ? {} : { documentIndex: document.documentIndex }),
		...(location?.documentChar ? { startIndex: location.documentChar.start, endIndex: location.documentChar.end } : {}),
		...(location?.documentPage ? { startPage: location.documentPage.start, endPage: location.documentPage.end } : {}),
	};
}
