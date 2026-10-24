import type { CitationsDelta } from "@aws-sdk/client-bedrock-runtime";
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
