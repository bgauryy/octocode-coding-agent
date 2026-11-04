import { Container } from "@octocodeai/octocode-tui";
import { renderIsolated } from "../../../../../packages/tui/src/tui/render-isolation.ts";
if (process.env.OLD) {
	(Container.prototype as any).render = function (this: any, width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) for (const line of renderIsolated(child, width)) lines.push(line);
		return lines;
	};
}
