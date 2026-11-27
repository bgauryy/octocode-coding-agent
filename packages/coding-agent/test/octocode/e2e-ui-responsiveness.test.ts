import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, expect, it } from "vitest";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/**
 * Responsiveness ceilings for the fullscreen host on an xterm grid: process CPU per wheel event and per key, bytes per
 * scroll frame, event-loop lag and synchronous file-system calls on the main thread. CPU time, not wall time, so a
 * loaded machine stretches the clock without failing the check. Ceilings carry headroom over the measured baseline.
 */
/** Measured 117-134 for one 300-word turn; the headroom covers a lock retry or a cold cache. */
const STREAM_CEILING = 170;
const CEILING = {
	// Process CPU includes the test terminal's own xterm parser (about half of it).
	wheelCpuMsPerEvent: 5,
	keyCpuMsPerKey: 6,
	scrollBytesPerFrame: 8 * 1024,
	loopLagMs: 100,
	/** Synchronous fs calls on the main thread across the wheel and typing phases (128 before path lookups were cached). */
	syncFsCalls: 60,
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

/** Counts calls to `fs.*Sync` while `on` is set; the CommonJS module object is the one every import shares. */
const syncFs = (() => {
	const fs = createRequire(import.meta.url)("node:fs") as Record<string, unknown>;
	const state = { on: false, calls: 0 };
	for (const name of Object.keys(fs)) {
		const original = fs[name];
		if (!name.endsWith("Sync") || typeof original !== "function") continue;
		fs[name] = function (this: unknown, ...args: unknown[]) {
			if (state.on) state.calls++;
			return (original as (...a: unknown[]) => unknown).apply(this, args);
		};
	}
	return state;
})();

interface PhaseResult {
	cpuMs: number;
	writes: number;
	bytes: number;
	loopLagMs: number;
	syncFs: number;
}

async function phase(run: () => Promise<void>): Promise<PhaseResult> {
	const terminal = t!.terminal as unknown as { write(data: string): void };
	const write = terminal.write.bind(terminal);
	const result = { cpuMs: 0, writes: 0, bytes: 0, loopLagMs: 0, syncFs: 0 };
	terminal.write = (data: string) => {
		result.writes++;
		result.bytes += Buffer.byteLength(data);
		write(data);
	};
	let last = performance.now();
	const lag = setInterval(() => {
		const now = performance.now();
		result.loopLagMs = Math.max(result.loopLagMs, now - last - 10);
		last = now;
	}, 10);
	syncFs.calls = 0;
	syncFs.on = true;
	const cpu = process.cpuUsage();
	try {
		await run();
	} finally {
		const used = process.cpuUsage(cpu);
		result.cpuMs = (used.user + used.system) / 1000;
		syncFs.on = false;
		result.syncFs = syncFs.calls;
		clearInterval(lag);
		terminal.write = write;
	}
	return result;
}

const paragraph = "Some **bold** text with `code` and a [link](src/a.ts:12) plus words that wrap the line.";
function reply(turn: number): string {
	const parts = [`## Turn ${turn}`];
	for (let k = 0; k < 20; k++)
		parts.push(k % 6 === 3 ? "```ts\nfunction f(a: number) {\n  return a * 2;\n}\n```" : `${paragraph} ${k}`);
	parts.push("| a | b |\n| - | - |\n| 1 | 2 |");
	return parts.join("\n\n");
}

/** Resolves once the screen took no writes for one quiet stretch: the frames a burst asked for have landed. */
async function settled(): Promise<void> {
	const terminal = t!.terminal as unknown as { write(data: string): void };
	const write = terminal.write.bind(terminal);
	let last = performance.now();
	terminal.write = (data: string) => {
		last = performance.now();
		write(data);
	};
	try {
		while (performance.now() - last < 60) await wait(20);
	} finally {
		terminal.write = write;
	}
}

it("keeps wheel and typing within their ceilings on a long transcript", { timeout: 300_000 }, async () => {
	t = await startUi();
	for (let turn = 0; turn < 15; turn++) {
		t.script(fauxAssistantMessage([fauxToolCall("bash", { command: `echo ${turn}`, reason: "r" })]), reply(turn));
		await t.type(`q${turn}`);
		t.press(KEY.enter);
		await t.until(() => !t!.host.session.isStreaming && t!.requests.length >= 2 * (turn + 1), `turn ${turn}`, 30_000);
	}
	await settled();

	const WHEEL = 200;
	const wheel = await phase(async () => {
		for (let k = 0; k < WHEEL; k++) {
			t!.press(`\x1b[<${k < WHEEL / 2 ? 64 : 65};10;10M`);
			await wait(8);
		}
		await settled();
	});
	const KEYS = 80;
	const typing = await phase(async () => {
		for (let k = 0; k < KEYS; k++) {
			t!.press("abcdefghij".charAt(k % 10));
			await wait(25);
		}
		await settled();
	});

	const summary = {
		wheelCpuMsPerEvent: wheel.cpuMs / WHEEL,
		keyCpuMsPerKey: typing.cpuMs / KEYS,
		scrollBytesPerFrame: wheel.bytes / Math.max(1, wheel.writes),
		loopLagMs: Math.max(wheel.loopLagMs, typing.loopLagMs),
		syncFsCalls: wheel.syncFs + typing.syncFs,
	};
	for (const key of Object.keys(CEILING) as (keyof typeof CEILING)[]) {
		expect(summary[key], `${key} ${JSON.stringify(summary)}`).toBeLessThanOrEqual(CEILING[key]);
	}
	expect(wheel.writes).toBeGreaterThan(0);
});

it("keeps a paced streamed turn within its synchronous fs ceiling", { timeout: 120_000 }, async () => {
	t = await startUi({ tokensPerSecond: 200 });
	let calls = 0;
	for (let turn = 0; turn < 2; turn++) {
		t.script(fauxAssistantMessage("word ".repeat(300)));
		await t.type(`q${turn}`);
		const counted = turn === 1;
		syncFs.calls = 0;
		syncFs.on = counted;
		t.press(KEY.enter);
		await t.until(() => !t!.host.session.isStreaming && t!.requests.length >= turn + 1, `turn ${turn}`, 60_000);
		syncFs.on = false;
		if (counted) calls = syncFs.calls;
	}
	expect(calls, `streamSyncFsCalls ${calls}`).toBeLessThanOrEqual(STREAM_CEILING);
});
