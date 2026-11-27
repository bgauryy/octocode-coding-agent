/** How a union with shared fields (`properties` beside `anyOf`/`oneOf`) splits its keys between the shared part and the branches. */

import { isNode, isShapeless, type Node } from "./schema-nodes.ts";

/** The keys a node's own `required` lists. */
export const requiredOf = (node: unknown): Set<string> =>
	new Set(isNode(node) && Array.isArray(node.required) ? node.required.map(String) : []);

/**
 * The shared part's required keys and placeholders. `branches` are the union's dereferenced branches with a shape,
 * one per branch.
 */
export function sharedUnionKeys(
	shared: Node,
	branches: unknown[],
): { requiredEverywhere: string[]; placeholders: Set<string> } {
	const sharedProperties = shared.properties as Node;
	const parentRequired = requiredOf(shared);
	const objectBranches = branches.filter(
		(node): node is Node => isNode(node) && !node.anyOf && !node.oneOf && isNode(node.properties),
	);
	// A key every branch requires is required on the shared part, even when the parent's own `required` omits it.
	const requiredEverywhere = Object.keys(sharedProperties).filter(
		(key) =>
			parentRequired.has(key) ||
			(objectBranches.length === branches.length &&
				objectBranches.length > 0 &&
				objectBranches.every((node) => requiredOf(node).has(key))),
	);
	// A shapeless shared field a branch types (`operation: unknown` beside `operation: "resolve"`) is a placeholder: the
	// branches carry its type and doc, so it records none of its own.
	const placeholders = new Set(
		Object.keys(sharedProperties).filter(
			(key) =>
				isShapeless(sharedProperties[key]) &&
				branches.some((node) => isNode(node) && isNode(node.properties) && !isShapeless(node.properties[key])),
		),
	);
	return { requiredEverywhere, placeholders };
}
