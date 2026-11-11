/** The part of Mermaid this page uses. */
export interface MermaidApi {
	initialize(config: Record<string, unknown>): void;
	render(id: string, text: string): Promise<{ svg: string }>;
}

let loading: Promise<MermaidApi> | undefined;

/**
 * Mermaid, loaded once and only when a diagram needs it. The host serves the script under the page's token; it runs as an
 * inline script, which the meta policy's `script-src 'unsafe-inline'` allows and the servers' hash-only header allows by
 * `MERMAID_SCRIPT_HASH`, the hash of exactly this text. A failed load is forgotten so a later diagram can try again.
 */
export function loadMermaid(fetchScript: () => Promise<string>): Promise<MermaidApi> {
	const existing = (globalThis as { mermaid?: MermaidApi }).mermaid;
	if (existing) return Promise.resolve(existing);
	loading ??= fetchScript().then((script) => {
		const element = document.createElement("script");
		element.textContent = script;
		document.head.append(element);
		element.remove();
		const api = (globalThis as { mermaid?: MermaidApi }).mermaid;
		if (!api) throw new Error("The diagram renderer did not start");
		return api;
	});
	loading.catch(() => {
		loading = undefined;
	});
	return loading;
}
