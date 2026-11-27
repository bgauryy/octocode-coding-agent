import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { ProgressIndicator } from "../src/terminal/progress.ts";
import { TITLE_FRAME_MS, TitlePainter, type TitleState } from "../src/terminal/title-painter.ts";

const ACTIVE = "\x1b]9;4;3\x07";
const CLEAR = "\x1b]9;4;0\x07";

describe("progress while the terminal is stalled", () => {
	afterEach(() => mock.timers.reset());

	it("writes nothing while gated, then only the latest state on the next allowed tick", () => {
		// The keepalive ticks on the animation clock, which reads the time as well as its interval.
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let allowed = false;
		const written: string[] = [];
		const progress = new ProgressIndicator(
			() => allowed,
			(sequence) => written.push(sequence),
			() => allowed,
		);
		progress.set(true);
		progress.set(false);
		progress.set(true);
		mock.timers.tick(3_000);
		assert.deepEqual(written, []);
		allowed = true;
		mock.timers.tick(1_000);
		assert.deepEqual(written, [ACTIVE]);
		mock.timers.tick(1_000);
		assert.deepEqual(written, [ACTIVE, ACTIVE], "keepalive resumes");
		progress.clear();
		assert.deepEqual(written, [ACTIVE, ACTIVE, CLEAR]);
	});

	it("retries a clear that had to wait, once, and stops ticking", () => {
		// The keepalive ticks on the animation clock, which reads the time as well as its interval.
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let allowed = true;
		const written: string[] = [];
		const progress = new ProgressIndicator(
			() => allowed,
			(sequence) => written.push(sequence),
			() => allowed,
		);
		progress.set(true);
		allowed = false;
		progress.set(false);
		mock.timers.tick(2_000);
		assert.deepEqual(written, [ACTIVE]);
		allowed = true;
		mock.timers.tick(5_000);
		assert.deepEqual(written, [ACTIVE, CLEAR]);
		progress.clear();
		assert.deepEqual(written, [ACTIVE, CLEAR], "nothing left to clear");
	});

	it("does not clear an indicator that was never shown, unless forced", () => {
		const written: string[] = [];
		const progress = new ProgressIndicator(
			() => false,
			(sequence) => written.push(sequence),
			() => false,
		);
		progress.set(true);
		progress.clear();
		assert.deepEqual(written, []);
		progress.clear(undefined, true);
		assert.deepEqual(written, [CLEAR]);
	});
});

describe("title while output is backed up", () => {
	afterEach(() => mock.timers.reset());

	it("holds titles while gated and writes the latest once the terminal reads; forced repaints pass", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		let allowed = false;
		let state: TitleState = "waiting";
		const titles: string[] = [];
		const painter = new TitlePainter(
			{
				state: () => state,
				target: () => ({ cwd: "/repo", setTitle: (text) => titles.push(text) }),
				description: () => undefined,
				agents: () => 0,
			},
			{ full: (current) => current, plain: () => "plain" },
			() => allowed,
		);
		painter.paint();
		state = "done";
		painter.paint();
		mock.timers.tick(TITLE_FRAME_MS * 3);
		assert.deepEqual(titles, []);
		allowed = true;
		mock.timers.tick(TITLE_FRAME_MS);
		assert.deepEqual(titles, ["done"]);
		mock.timers.tick(TITLE_FRAME_MS * 3);
		assert.deepEqual(titles, ["done"], "no retry after it landed");
		allowed = false;
		painter.paint(true);
		assert.deepEqual(titles, ["done", "done"]);
		painter.stop();
	});
});
