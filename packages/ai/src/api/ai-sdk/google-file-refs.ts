/**
 * Vertex assistant file references (`fileData`).
 *
 * @ai-sdk/google refuses provider-reference file parts for Vertex, so replay sends them as a placeholder text part
 * and `restoreVertexFileParts` turns each placeholder back into a `fileData` part in the request body, keeping its
 * position and thought signature.
 */
const MARKER = "\u0000octocode-vertex-file\u0000";

interface FileData {
	fileUri: string;
	mimeType: string;
}

export function vertexFilePlaceholder(fileUri: string, mimeType: string): string {
	return MARKER + JSON.stringify({ fileUri, mimeType } satisfies FileData);
}

interface WirePart {
	text?: string;
	thoughtSignature?: string;
}

export function restoreVertexFileParts(body: Record<string, unknown>): void {
	const contents = body.contents as { parts?: WirePart[] }[] | undefined;
	for (const content of contents ?? []) {
		const parts = content.parts;
		if (!parts) continue;
		for (let index = 0; index < parts.length; index++) {
			const { text, thoughtSignature } = parts[index];
			if (typeof text !== "string" || !text.startsWith(MARKER)) continue;
			const fileData = JSON.parse(text.slice(MARKER.length)) as FileData;
			parts[index] = { fileData, ...(thoughtSignature ? { thoughtSignature } : {}) } as WirePart;
		}
	}
}
