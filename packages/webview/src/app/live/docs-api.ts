import { DOC_KINDS, DOCS_ROUTES, type DocFile, type DocsIndex } from "@octocodeai/octocode-contracts/docs";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { bearer } from "../../access.ts";
import { requestJson } from "../../request.ts";
import { scopedRoute } from "../../scope.ts";

function isDocSummary(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.kind === "string" &&
		(DOC_KINDS as readonly string[]).includes(value.kind) &&
		typeof value.topic === "string" &&
		typeof value.title === "string" &&
		typeof value.updated === "string" &&
		typeof value.bytes === "number"
	);
}

/** The docs library's authenticated reads; the host decides what exists and what may be served. */
export function createDocsApi(access: string) {
	const authorization = bearer(access);
	return {
		docs: async (includeTmp: boolean, signal?: AbortSignal): Promise<DocsIndex> => {
			const value = await requestJson(
				`${scopedRoute(DOCS_ROUTES.index)}${includeTmp ? "?tmp=1" : ""}`,
				{ headers: authorization, signal },
				"Could not load documents",
			);
			if (!isRecord(value) || !Array.isArray(value.docs) || !value.docs.every(isDocSummary))
				throw new Error("Invalid documents response");
			return value as unknown as DocsIndex;
		},
		docFile: async (path: string, includeTmp: boolean, signal?: AbortSignal): Promise<DocFile> => {
			const value = await requestJson(
				`${scopedRoute(DOCS_ROUTES.file)}?${new URLSearchParams({ path, ...(includeTmp ? { tmp: "1" } : {}) })}`,
				{ headers: authorization, signal },
				"Could not load the document",
			);
			if (!isRecord(value) || value.path !== path || typeof value.markdown !== "string")
				throw new Error("Invalid document response");
			return value as unknown as DocFile;
		},
		/** The bundled Mermaid script as text; fetched once, when the first diagram needs it. */
		mermaidScript: async (signal?: AbortSignal): Promise<string> => {
			const value = await requestJson(
				scopedRoute(DOCS_ROUTES.mermaid),
				{ headers: authorization, signal },
				"Could not load the diagram renderer",
			);
			if (!isRecord(value) || typeof value.script !== "string") throw new Error("Invalid diagram renderer response");
			return value.script;
		},
	};
}
