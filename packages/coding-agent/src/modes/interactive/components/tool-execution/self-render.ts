import {
	type Component,
	type Container,
	isRenderStable,
	linkRenderChild,
	renderSerial,
	settleRender,
} from "@octocodeai/octocode-tui";
import type { ImageRows } from "./images.ts";

/**
 * Renders a `renderShell: "self"` tool row and settles its composite render state so parents can skip it when quiet.
 */
export function renderSelfShell(
	owner: Component,
	selfRenderContainer: Container,
	images: ImageRows,
	width: number,
): { lines: string[]; selfRenderHeight: number } {
	linkRenderChild(owner, selfRenderContainer);
	const before = renderSerial();
	const contentLines = selfRenderContainer.render(width);
	let stable = isRenderStable(selfRenderContainer, before);
	if (contentLines.length === 0 && images.components.length === 0) {
		settleRender(owner, stable);
		return { lines: [], selfRenderHeight: 0 };
	}

	const lines: string[] = [];
	if (contentLines.length > 0) {
		lines.push("");
		lines.push(...contentLines);
	}
	for (const [index, image] of images.components.entries()) {
		const spacer = images.spacers[index];
		if (spacer) {
			linkRenderChild(owner, spacer);
			lines.push(...spacer.render(width));
			stable = stable && isRenderStable(spacer, before);
		}
		linkRenderChild(owner, image);
		lines.push(...image.render(width));
		stable = stable && isRenderStable(image, before);
	}
	settleRender(owner, stable);
	return { lines, selfRenderHeight: contentLines.length };
}
