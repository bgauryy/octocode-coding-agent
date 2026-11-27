import type { VertexNodeModule } from "./vertex-node.ts";

let vertexNodeOverride: VertexNodeModule | undefined;

/**
 * Registers the Vertex credentials module statically. Used by single-file builds (the Bun binary), where the
 * opaque runtime import below cannot be bundled.
 */
export function setVertexNodeModule(module: VertexNodeModule): void {
	vertexNodeOverride = module;
}

/**
 * Loads the Vertex credentials module (google-auth-library, node:fs) through a variable specifier, so browser
 * bundles never follow it. The `.ts`/`.js` rewrite keeps it working from source and built output.
 */
export async function loadVertexNodeModule(): Promise<VertexNodeModule> {
	if (vertexNodeOverride) return vertexNodeOverride;
	const specifier = import.meta.url.endsWith(".js") ? "./vertex-node.js" : "./vertex-node.ts";
	const module = (await import(new URL(specifier, import.meta.url).href)) as { vertexNodeModule: VertexNodeModule };
	return module.vertexNodeModule;
}
