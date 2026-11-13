import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Container } from "../src/tui/container.ts";
import { FocusManager } from "../src/tui/focus-manager.ts";
import type { Component } from "../src/tui.ts";

class Leaf implements Component {
	focused = false;
	render(): string[] {
		return ["leaf"];
	}
	invalidate(): void {}
	handleInput(): void {}
}

/** The focus manager as it was: every render request walks the tree for a focus owner not yet remembered. */
class WalkingFocusManager extends FocusManager {
	walks = 0;
	override rememberMountedFocus(): void {
		const focused = this.focusedComponent;
		if (!focused) return;
		const owners = (this as unknown as { mountedFocusOwners: WeakSet<Component> }).mountedFocusOwners;
		if (owners.has(focused)) return;
		this.walks++;
		if (this.isComponentMounted(focused)) owners.add(focused);
	}
}

function random(seed: number): (limit: number) => number {
	let state = seed;
	return (limit) => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return Math.floor((state / 2147483648) * limit);
	};
}

interface Tree {
	root: Container;
	containers: Container[];
	leaves: Leaf[];
	detached: Leaf[];
	overlays: Leaf[];
}

/** A random tree of containers and leaves. */
function buildTree(next: (limit: number) => number): Tree {
	const root = new Container();
	const containers = [root];
	const leaves: Leaf[] = [];
	for (let index = 0; index < 60; index++) {
		const parent = containers[next(containers.length)];
		if (next(3) === 0) {
			const container = new Container();
			parent.addChild(container);
			containers.push(container);
		} else {
			const leaf = new Leaf();
			parent.addChild(leaf);
			leaves.push(leaf);
		}
	}
	return { root, containers, leaves, detached: [new Leaf(), new Leaf()], overlays: [new Leaf(), new Leaf()] };
}

/** The same shape with new components. */
function copyTree(tree: Tree): Tree {
	const map = new Map<Component, Component>();
	const copy = (component: Component): Component => {
		const made = component instanceof Container ? new Container() : new Leaf();
		if (component instanceof Container)
			for (const child of component.children) (made as Container).addChild(copy(child));
		map.set(component, made);
		return made;
	};
	return {
		root: copy(tree.root) as Container,
		containers: tree.containers.map((container) => map.get(container) as Container),
		leaves: tree.leaves.map((leaf) => map.get(leaf) as Leaf),
		detached: [new Leaf(), new Leaf()],
		overlays: [new Leaf(), new Leaf()],
	};
}

describe("focus checks on render requests", () => {
	it("decide focus exactly as walking the tree on every request does", () => {
		for (let seed = 1; seed <= 12; seed++) {
			const next = random(seed);
			const a = buildTree(next);
			const b = copyTree(a);
			const managers = [a, b].map((tree, index) => {
				const host = {
					viewport: () => ({ columns: 80, rows: 24 }),
					mountedRoots: () => [tree.root],
					requestRender: () => {},
					hideCursor: () => {},
				};
				return index === 0 ? new FocusManager(host) : new WalkingFocusManager(host);
			});
			const trees = [a, b];
			const handles: Array<Array<{ hide(): void } | undefined>> = [[], []];
			for (let step = 0; step < 400; step++) {
				const op = next(10);
				const pick = next(1000);
				trees.forEach((tree, side) => {
					const manager = managers[side];
					const leaf = tree.leaves[pick % tree.leaves.length];
					const container = tree.containers[pick % tree.containers.length];
					if (op === 0) manager.setFocus(leaf);
					else if (op === 1) manager.setFocus(tree.detached[pick % 2]);
					else if (op === 2) handles[side].push(manager.showOverlay(tree.overlays[pick % 2]));
					else if (op === 3) handles[side].pop()?.hide();
					else if (op === 4) {
						// A leaf leaves the tree, or comes back to it.
						if (container.children.includes(leaf)) container.removeChild(leaf);
						else if (!tree.root.children.includes(leaf)) tree.root.addChild(leaf);
					} else if (op === 5) container.children.reverse();
					else if (op === 8) {
						// A widget focused while detached is mounted, or leaves again.
						const widget = tree.detached[pick % 2];
						if (tree.root.children.includes(widget)) tree.root.removeChild(widget);
						else tree.root.addChild(widget);
					} else if (op === 6) manager.reconcileFocus();
					else manager.rememberMountedFocus();
				});
				const [cached, walking] = managers;
				const index = (tree: (typeof trees)[number], component: Component | null) =>
					component === null
						? "none"
						: `${tree.leaves.indexOf(component as Leaf)}/${tree.detached.indexOf(component as Leaf)}/${tree.overlays.indexOf(component as Leaf)}`;
				assert.equal(
					index(a, cached.focusedComponent),
					index(b, walking.focusedComponent),
					`seed ${seed}, step ${step}, op ${op}`,
				);
			}
		}
	});

	it("walks the tree once while an overlay or a detached widget keeps focus across render requests", () => {
		const root = new Container();
		for (let index = 0; index < 50; index++) root.addChild(new Leaf());
		const manager = new FocusManager({
			viewport: () => ({ columns: 80, rows: 24 }),
			mountedRoots: () => [root],
			requestRender: () => {},
			hideCursor: () => {},
		});
		let walks = 0;
		const walk = manager.isComponentMounted.bind(manager);
		manager.isComponentMounted = (component) => {
			walks++;
			return walk(component);
		};
		manager.showOverlay(new Leaf());
		walks = 0;
		for (let request = 0; request < 100; request++) manager.rememberMountedFocus();
		assert.equal(walks, 0, "a focused overlay is not looked for in the tree");
		manager.setFocus(new Leaf());
		walks = 0;
		for (let request = 0; request < 100; request++) manager.rememberMountedFocus();
		assert.equal(walks, 1, "one walk, then the cache");
		root.addChild(new Leaf());
		manager.rememberMountedFocus();
		assert.equal(walks, 2, "an edit of a children list walks again");
	});
	it("notices a widget mounted after focus first missed it, then removed", () => {
		for (const Manager of [FocusManager, WalkingFocusManager]) {
			const root = new Container();
			const manager = new Manager({
				viewport: () => ({ columns: 80, rows: 24 }),
				mountedRoots: () => [root],
				requestRender: () => {},
				hideCursor: () => {},
			});
			const widget = new Leaf();
			manager.setFocus(widget);
			manager.rememberMountedFocus();
			root.addChild(widget);
			manager.rememberMountedFocus();
			root.removeChild(widget);
			manager.reconcileFocus();
			assert.equal(manager.focusedComponent, null, Manager.name);
		}
	});
});
