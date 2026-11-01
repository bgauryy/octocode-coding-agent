/**
 * The locally bundled Mermaid script, loaded only when the host is asked for it (a document with a diagram opened).
 * Kept behind a dynamic import so the host does not hold several megabytes of script in memory until then.
 */
export async function mermaidScript(): Promise<string> {
	return (await import("./mermaid.generated.ts")).MERMAID_JS;
}
