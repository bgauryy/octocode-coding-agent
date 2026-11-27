import assert from "node:assert";
import { describe, it } from "node:test";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { Text } from "../src/components/text.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * A width change in a 5000-row transcript of CJK or emoji text at 100 columns. Each frame (one `doRender`) must stay
 * under 50 ms of CPU, so input keeps flowing while the transcript is laid out again; the frame at the new width still
 * paints every row. A forced redraw at the same width is held to the same budget. CPU time, not wall time, is asserted: the test host may be loaded. `TUI_REDRAW_BENCH=1` prints
 * per-frame CPU and wall times and the event-loop delay.
 */

const ROWS = 5000;
const FRAME_CPU_BUDGET_MS = 50;
const bench = process.env.TUI_REDRAW_BENCH === "1";

const lines: Record<string, (i: number) => string> = {
	cjk: (i) => `行${i} ${"这是一个很长的中文句子用于测试宽度计算".repeat(3)}`,
	emoji: (i) => `🚀${i} ${"😀 emoji 👨‍👩‍👧‍👦 mixed 🇯🇵 text ".repeat(4)}`,
};

/** The terminal paints nothing: the cost measured is layout and diffing, not xterm parsing. */
class SinkTerminal extends VirtualTerminal {
	override write(_data: string): void {}
}

interface Frame {
	cpuMs: number;
	wallMs: number;
	width: number;
}

function recordFrames(tui: TuiMainScreen): Frame[] {
	const frames: Frame[] = [];
	const target = tui as unknown as { doRender(): void; previousWidth: number };
	const doRender = target.doRender.bind(tui);
	target.doRender = () => {
		const cpu = process.cpuUsage();
		const start = performance.now();
		doRender();
		const used = process.cpuUsage(cpu);
		frames.push({
			cpuMs: (used.user + used.system) / 1000,
			wallMs: performance.now() - start,
			width: target.previousWidth,
		});
	};
	return frames;
}

/** Waits until the last frame is at `width` and no frame followed it for longer than the frame interval. */
async function settle(frames: Frame[], width: number): Promise<void> {
	const deadline = performance.now() + 30_000;
	let seen = -1;
	while (frames.at(-1)?.width !== width || seen !== frames.length) {
		assert.ok(performance.now() < deadline, `no settled frame at width ${width} within 30 s`);
		seen = frames.length;
		await sleep(150);
	}
}

describe("full redraw of a long wide-text transcript", () => {
	for (const [kind, line] of Object.entries(lines)) {
		it(`keeps every frame of a ${ROWS}-row ${kind} width change under ${FRAME_CPU_BUDGET_MS} ms CPU`, async () => {
			const terminal = new SinkTerminal(100, 40);
			const tui = new TuiMainScreen(terminal);
			for (let i = 0; i < ROWS; i++) tui.addChild(new Text(line(i), 0, 0));
			const frames = recordFrames(tui);
			tui.start();
			try {
				await settle(frames, 100);
				for (const [width, step] of [
					[120, "resize"],
					[120, "force"],
					[100, "resize"],
					[120, "resize"],
					[100, "resize"],
				] as const) {
					frames.length = 0;
					const delay = monitorEventLoopDelay({ resolution: 5 });
					delay.enable();
					if (step === "force") tui.requestRender(true);
					else terminal.resize(width, 40);
					await settle(frames, width);
					delay.disable();
					const maxCpu = Math.max(...frames.map((frame) => frame.cpuMs));
					if (bench) {
						const cpu = frames.map((frame) => frame.cpuMs.toFixed(1)).join(" ");
						const wall = frames.map((frame) => frame.wallMs.toFixed(1)).join(" ");
						const loop = (delay.max / 1e6).toFixed(1);
						console.log(`${kind} ${step} ${width}: frames cpu [${cpu}] wall [${wall}] max loop delay ${loop} ms`);
					}
					assert.ok(
						maxCpu < FRAME_CPU_BUDGET_MS,
						`${kind} ${step} ${width}: a frame took ${maxCpu.toFixed(1)} ms CPU (budget ${FRAME_CPU_BUDGET_MS} ms)`,
					);
				}
			} finally {
				tui.stop();
			}
		});
	}
});
