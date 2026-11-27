import { visibleWidth } from "../utils/width.ts";

interface FractionNode {
	type: "fraction";
	numerator: string;
	denominator: string;
}

interface OperatorNode {
	type: "operator";
	operator: string;
	lower?: string;
	upper?: string;
}

interface ScriptNode {
	type: "script";
	lower?: string;
	upper?: string;
}

interface MatrixNode {
	type: "matrix";
	lines: string[];
	baseline: number;
}

export type LayoutNode = FractionNode | OperatorNode | ScriptNode | MatrixNode;

interface Layout {
	lines: string[];
	width: number;
	baseline: number;
}

export const LAYOUT_MARKER_START = "\u{f0000}";
export const LAYOUT_MARKER_END = "\u{f0001}";
const LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}/gu;
export const TRAILING_LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}$/u;
export const PROTECTED_SPACE = "\u{f0002}";

function padLayoutLine(line: string, width: number, centered = false): string {
	const padding = Math.max(0, width - visibleWidth(line));
	const left = centered ? Math.floor(padding / 2) : 0;
	return `${" ".repeat(left)}${line}${" ".repeat(padding - left)}`;
}

function joinLayouts(layouts: readonly Layout[]): Layout {
	if (layouts.length === 0) {
		return { lines: [""], width: 0, baseline: 0 };
	}
	const baseline = Math.max(...layouts.map((layout) => layout.baseline));
	const below = Math.max(...layouts.map((layout) => layout.lines.length - layout.baseline - 1));
	const lines: string[] = [];
	for (let row = 0; row <= baseline + below; row++) {
		let line = "";
		for (const layout of layouts) {
			const sourceRow = row - baseline + layout.baseline;
			line +=
				sourceRow >= 0 && sourceRow < layout.lines.length
					? padLayoutLine(layout.lines[sourceRow] ?? "", layout.width)
					: " ".repeat(layout.width);
		}
		lines.push(line.trimEnd());
	}
	return {
		lines,
		width: layouts.reduce((width, layout) => width + layout.width, 0),
		baseline,
	};
}

export function renderLayout(source: string, nodes: readonly LayoutNode[]): Layout {
	const renderedLines: string[] = [];
	let firstBaseline = 0;
	for (const sourceLine of source.split("\n")) {
		const layouts: Layout[] = [];
		let position = 0;
		let previousNode: LayoutNode | undefined;
		for (const match of sourceLine.matchAll(LAYOUT_MARKER_PATTERN)) {
			const index = match.index;
			const node = nodes[Number(match[1])];
			if (!node) {
				continue;
			}
			if (index > position) {
				const sliced = sourceLine.slice(position, index);
				const trimmed = (previousNode ? sliced.trimStart() : sliced).trimEnd();
				const preserveLeadingSpace = previousNode?.type === "matrix" && /^\s/.test(sliced);
				const preserveTrailingSpace = node.type === "matrix" && /\s$/.test(sliced);
				const text = trimmed
					? `${preserveLeadingSpace ? " " : ""}${trimmed}${preserveTrailingSpace ? " " : ""}`
					: preserveLeadingSpace || preserveTrailingSpace
						? " "
						: "";
				layouts.push({ lines: [text], width: visibleWidth(text), baseline: 0 });
			}
			if (node.type === "fraction") {
				const numerator = renderLayout(node.numerator, nodes);
				const denominator = renderLayout(node.denominator, nodes);
				const contentWidth = Math.max(numerator.width, denominator.width, 1);
				const width = contentWidth + 2;
				layouts.push({
					lines: [
						...numerator.lines.map((line) => padLayoutLine(line, width, true)),
						` ${"─".repeat(contentWidth)} `,
						...denominator.lines.map((line) => padLayoutLine(line, width, true)),
					],
					width,
					baseline: numerator.lines.length,
				});
			} else if (node.type === "operator") {
				const contentWidth = Math.max(
					visibleWidth(node.operator),
					node.lower === undefined ? 0 : visibleWidth(node.lower),
					node.upper === undefined ? 0 : visibleWidth(node.upper),
				);
				const lines: string[] = [];
				if (node.upper !== undefined) {
					lines.push(`${padLayoutLine(node.upper, contentWidth, true)} `);
				}
				lines.push(`${padLayoutLine(node.operator, contentWidth, true)} `);
				if (node.lower !== undefined) {
					lines.push(`${padLayoutLine(node.lower, contentWidth, true)} `);
				}
				layouts.push({
					lines,
					width: contentWidth + 1,
					baseline: node.upper === undefined ? 0 : 1,
				});
			} else if (node.type === "script") {
				const upper = node.upper === undefined ? undefined : renderLayout(node.upper, nodes);
				const lower = node.lower === undefined ? undefined : renderLayout(node.lower, nodes);
				const width = Math.max(upper?.width ?? 0, lower?.width ?? 0);
				layouts.push({
					lines: [
						...(upper?.lines.map((line) => padLayoutLine(line, width)) ?? []),
						" ".repeat(width),
						...(lower?.lines.map((line) => padLayoutLine(line, width)) ?? []),
					],
					width,
					baseline: upper?.lines.length ?? 0,
				});
			} else {
				const width = Math.max(0, ...node.lines.map((line) => visibleWidth(line)));
				layouts.push({
					lines: node.lines.map((line) => padLayoutLine(line, width)),
					width,
					baseline: node.baseline,
				});
			}
			position = index + match[0].length;
			previousNode = node;
		}
		if (position < sourceLine.length) {
			const sliced = sourceLine.slice(position);
			const trimmed = previousNode ? sliced.trimStart() : sliced;
			const text = previousNode?.type === "matrix" && /^\s/.test(sliced) ? ` ${trimmed}` : trimmed;
			layouts.push({ lines: [text], width: visibleWidth(text), baseline: 0 });
		}
		const lineLayout = joinLayouts(layouts);
		if (renderedLines.length === 0) {
			firstBaseline = lineLayout.baseline;
		}
		renderedLines.push(...lineLayout.lines);
	}
	return {
		lines: renderedLines,
		width: Math.max(0, ...renderedLines.map((line) => visibleWidth(line))),
		baseline: firstBaseline,
	};
}
