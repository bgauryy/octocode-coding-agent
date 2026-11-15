#!/usr/bin/env node
/** Offline scheduler comparison with a deterministic synthetic component and slow terminal consumer. */
import { performance } from "node:perf_hooks";
import { TuiMainScreen } from "../packages/tui/src/tui-main-screen.ts";

const argument = (name, fallback) => {
	const i = process.argv.indexOf(name);
	const n = i === -1 ? fallback : Number(process.argv[i + 1]);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
	return n;
};
const durationMs = argument("--duration-ms", 3000);
const trials = argument("--trials", 3);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, fraction) => {
	if (!values.length) return null;
	const ordered = [...values].sort((a, b) => a - b);
	return ordered[Math.ceil(fraction * ordered.length) - 1];
};

class SlowTerminal {
	columns = 80;
	rows = 240;
	kittyProtocolActive = false;
	pendingOutputBytes = 0;
	writtenBytes = 0;
	maxPendingBytes = 0;
	writeCalls = 0;
	#onInput;
	start(onInput) {
		this.#onInput = onInput;
	}
	stop() {
		this.#onInput = undefined;
	}
	async drainInput() {}
	write(text) {
		const bytes = Buffer.byteLength(text);
		this.writtenBytes += bytes;
		this.writeCalls++;
		this.pendingOutputBytes += bytes;
		this.maxPendingBytes = Math.max(this.maxPendingBytes, this.pendingOutputBytes);
	}
	drain(bytes) {
		this.pendingOutputBytes = Math.max(0, this.pendingOutputBytes - bytes);
	}
	sendInput() {
		this.#onInput?.("x");
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	setProgramStatus() {}
}

class WorkloadComponent {
	sequence = 0;
	inputAt = undefined;
	render() {
		// Change every row on each state revision so diff generation and output are repeatable.
		return Array.from(
			{ length: 240 },
			(_, i) => `${this.sequence}:${i.toString().padStart(3, "0")}:${"text".repeat(12)}`,
		);
	}
	invalidate() {}
	handleInput() {
		this.sequence++;
		this.inputAt = performance.now();
	}
}

class MeasuredTui extends TuiMainScreen {
	paints = 0;
	latestPainted = -1;
	inputLatencies = [];
	constructor(terminal, component) {
		super(terminal);
		this.component = component;
	}
	doRender() {
		super.doRender();
		this.paints++;
		this.latestPainted = this.component.sequence;
		if (this.component.inputAt !== undefined) {
			this.inputLatencies.push(performance.now() - this.component.inputAt);
			this.component.inputAt = undefined;
		}
		// Repeatable CPU pressure to exercise adaptive cadence separately from output pressure.
		const until = performance.now() + 30;
		while (performance.now() < until) {
			// Busy-wait on purpose: the CPU pressure is what this trial measures.
		}
	}
}

async function trial(name, config) {
	const terminal = new SlowTerminal();
	const component = new WorkloadComponent();
	const tui = new MeasuredTui(terminal, component);
	tui.addChild(component);
	tui.setFocus(component);
	tui.setRenderPacing({ ...config, metrics: true });
	const heapBefore = process.memoryUsage().heapUsed;
	const start = performance.now();
	let normalDrain = true;
	const drainTimer = setInterval(() => terminal.drain(normalDrain ? 512 : 96 * 1024), 10);
	try {
		tui.start();
		tui.renderNow();
		let nextInput = 120;
		while (performance.now() - start < durationMs) {
			component.sequence++;
			tui.requestRender();
			if (performance.now() - start >= nextInput) {
				terminal.sendInput();
				nextInput += 120;
			}
			await pause(5);
		}
		component.sequence++;
		const finalSequence = component.sequence;
		const finalAt = performance.now();
		tui.requestRender();
		normalDrain = false;
		const deadline = performance.now() + 2000;
		while (tui.latestPainted !== finalSequence && performance.now() < deadline) await pause(5);
		const finalFrameEnqueueLatencyMs = tui.latestPainted === finalSequence ? performance.now() - finalAt : null;
		while (terminal.pendingOutputBytes > 0 && performance.now() < deadline) await pause(5);
		return {
			mode: name,
			pacing: config,
			frames: tui.paints,
			deferredChecks: tui.getRenderPacingStats().deferredFrames,
			writtenBytes: terminal.writtenBytes,
			maxPendingBytes: terminal.maxPendingBytes,
			maxTimerLagMs: tui.getRenderPacingStats().maxTimerLagMs,
			p95InputToPaintMs: percentile(tui.inputLatencies, 0.95),
			p99InputToPaintMs: percentile(tui.inputLatencies, 0.99),
			finalFrameEnqueueLatencyMs,
			finalDrainLatencyMs: terminal.pendingOutputBytes === 0 ? performance.now() - finalAt : null,
			heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
		};
	} finally {
		clearInterval(drainTimer);
		tui.stop();
	}
}

const modes = [
	["fixed", { outputGate: false, adaptiveCadence: false }],
	["gate", { outputGate: true, adaptiveCadence: false }],
	["adaptive", { outputGate: false, adaptiveCadence: true }],
	["both", { outputGate: true, adaptiveCadence: true }],
];
const results = [];
for (let t = 0; t < trials; t++) {
	for (const [name, config] of modes) results.push({ trial: t + 1, ...(await trial(name, config)) });
}
process.stdout.write(
	`${JSON.stringify(
		{
			kind: "offline-synthetic-render-scheduler",
			node: process.version,
			durationMs,
			trials,
			consumer: "512 bytes/10ms during streaming, 96KiB/10ms recovery",
			component: "240 visible changed rows/5ms, 30ms synthetic paint cost",
			limitations: "simulated output queue; not a PTY, provider run, or end-user latency result",
			results,
		},
		null,
		2,
	)}\n`,
);
