import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VisualLinePreview } from "../src/components/visual-truncate.ts";
import { recordUntrackedRenders } from "../src/tui/render-signal.ts";
import { Container } from "../src/tui.ts";

class Untracked {
	render(): string[] {
		return ["x"];
	}
	invalidate(): void {}
}

describe("recordUntrackedRenders", () => {
	it("names each untracked part a parent renders, per frame, and stops on its call", () => {
		const parent = new Container();
		parent.addChild(new Untracked());
		parent.addChild(new Untracked());
		parent.render(20);
		const stop = recordUntrackedRenders();
		parent.render(20);
		parent.render(20);
		assert.deepEqual(Object.fromEntries(stop()), { Untracked: 4 });
		const after = recordUntrackedRenders();
		const stopped = after();
		parent.render(20);
		assert.equal(stopped.size, 0, "nothing is counted once stopped");
	});
});

describe("VisualLinePreview in a transcript", () => {
	it("is tracked: skipped while quiet, drawn again after invalidate", () => {
		const original = VisualLinePreview.prototype.render;
		let draws = 0;
		VisualLinePreview.prototype.render = function (this: VisualLinePreview, width: number) {
			draws++;
			return original.call(this, width);
		};
		try {
			const preview = new VisualLinePreview({
				text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
				maxVisualLines: 5,
				keep: "end",
				formatHint: (hidden) => `+${hidden} earlier`,
			});
			const parent = new Container();
			parent.addChild(preview);
			assert.equal(parent.render(40)[0]?.trimEnd(), "+15 earlier");
			const stop = recordUntrackedRenders();
			const first = draws;
			parent.render(40);
			parent.render(40);
			assert.equal(draws, first, "a quiet preview is skipped");
			assert.equal(stop().size, 0);
			preview.invalidate();
			parent.render(40);
			assert.equal(draws, first + 1);
		} finally {
			VisualLinePreview.prototype.render = original;
		}
	});
});
