import { ScrollView } from "../components/scroll-view.ts";
import { getLayoutNode } from "../layout-node.ts";
import { Container, type Component } from "../tui.ts";

/** Detach every scroll view, including ones hidden by a stack's visibility predicate. */
export function detachScrollViews(...roots: Component[]): void {
	const visited = new Set<Component>();
	const visit = (component: Component): void => {
		if (visited.has(component)) return;
		visited.add(component);
		if (component instanceof ScrollView) component.detach();
		const node = getLayoutNode(component);
		if (node?.type === "scroll") visit(node.component);
		else if (node) for (const entry of node.entries) visit(entry.component);
		if (component instanceof Container) for (const child of component.children) visit(child);
	};
	for (const root of roots) visit(root);
}
