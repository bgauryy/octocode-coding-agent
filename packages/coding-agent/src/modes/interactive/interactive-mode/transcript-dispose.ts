import type { Component, Container } from "@octocodeai/octocode-tui";

/** Disposes one component and, recursively, its children. */
export function disposeComponent(component: Component, keep?: ReadonlySet<Component>): void {
	if (keep?.has(component)) return;
	(component as { dispose?(): void }).dispose?.();
	const children = (component as { children?: Component[] }).children;
	if (Array.isArray(children)) for (const child of children) disposeComponent(child, keep);
}

/**
 * Releases the clock and event subscriptions of the rows in a transcript container. Call it before `clear()` drops
 * them: a detached running row would otherwise keep the animation clock and render requests alive. Rows in `keep`
 * are re-added by the caller and stay live.
 */
export function disposeTranscript(container: Container, keep: Iterable<Component> = []): void {
	const kept = new Set<Component>(keep);
	for (const child of container.children) disposeComponent(child, kept);
}
