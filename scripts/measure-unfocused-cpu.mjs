// Terminal CPU with 1, 4 and 8 unfocused Octocode-like sessions: spinners at the old 200 ms unfocused cadence
// ("animate") vs the animation clock paused while unfocused ("paused"). No model, no network. It opens terminal windows
// in the background and closes them after each phase; leave them unfocused while it runs.
//   yarn measure:unfocused-cpu ghostty|terminal [--sessions 1,4,8] [--seconds 60] [--force]
// Internal: `--child <animate|paused> <seconds>` draws the synthetic session inside each window.
import { execFileSync, spawnSync } from "node:child_process";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROWS = 8;
const SETTLE_MS = 10_000;
/** The child declares itself unfocused only after the terminal's startup replies, which count as input, have arrived. */
const STARTUP_MS = 3_000;
const MAX_LOAD = 15;
const APPS = {
	ghostty: { label: "Ghostty", process: "ghostty" },
	terminal: { label: "Terminal.app", process: "terminal" },
};

async function child(mode, seconds) {
	const { ProcessTerminal } = await import("../packages/tui/src/terminal.ts");
	const { animationClock } = await import("../packages/tui/src/tokens/clock.ts");
	const { MOTION, SPINNER } = await import("../packages/tui/src/tokens/design.ts");
	const { TuiMainScreen } = await import("../packages/tui/src/tui-main-screen.ts");
	const tui = new TuiMainScreen(new ProcessTerminal());
	let frame = 0;
	tui.addChild({
		render: (width) =>
			Array.from({ length: ROWS }, (_, row) =>
				`${SPINNER.braille[(frame + row) % SPINNER.braille.length]} agent-${row} running tool call ${row * 7}s`.slice(
					0,
					width,
				),
			),
		invalidate() {},
	});
	tui.start();
	// animate: the previous behavior, a spinner that ticks at the background cadence whatever the focus (an `info`
	// subscription, which focus never pauses). paused: today's behavior, decoration that stops once focus leaves.
	const stop = animationClock.subscribe(
		() => {
			frame++;
			tui.requestRender();
		},
		mode === "paused"
			? { everyMs: MOTION.spinnerMs, kind: "decor" }
			: { everyMs: MOTION.backgroundSpinnerMs, kind: "info" },
	);
	if (mode === "paused") setTimeout(() => animationClock.setFocused(false), STARTUP_MS);
	tui.requestRender();
	const keepAlive = setInterval(() => {}, 1000);
	setTimeout(() => {
		stop();
		clearInterval(keepAlive);
		tui.stop();
		process.exit(0);
	}, seconds * 1000);
}

/** CPU seconds per pid, from `ps` (TIME is [h:]mm:ss.ss). */
function cpuTimes() {
	const out = execFileSync("ps", ["-A", "-o", "pid=,time=,args="], { encoding: "utf8" });
	const rows = new Map();
	for (const line of out.split("\n")) {
		const match = /^\s*(\d+)\s+([\d:.]+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const seconds = match[2].split(":").reduce((total, part) => total * 60 + Number(part), 0);
		rows.set(Number(match[1]), { seconds, args: match[3] });
	}
	return rows;
}

function isApp(args, processName) {
	const command = args.split(" ")[0] ?? "";
	return command.slice(command.lastIndexOf("/") + 1).toLowerCase() === processName;
}

const isSession = (args) => args.includes(SCRIPT) && args.includes("--child");

/**
 * Average % of one core over `ms`: the terminal (only `pids` when given, each Ghostty probe window being its own process;
 * else every process of the app) and the synthetic sessions.
 */
async function sample(app, ms, pids) {
	const before = cpuTimes();
	await sleep(ms);
	const after = cpuTimes();
	let terminal = 0;
	let sessions = 0;
	for (const [pid, row] of after) {
		const start = before.get(pid);
		if (!start || start.args !== row.args) continue;
		const used = row.seconds - start.seconds;
		if (pids ? pids.has(pid) : isApp(row.args, app.process) && !isSession(row.args)) terminal += used;
		else if (isSession(row.args) && !isApp(row.args, app.process)) sessions += used;
	}
	return { terminal: (terminal / ms) * 100_000, sessions: (sessions / ms) * 100_000 };
}

/** Opens `count` windows running the synthetic session; returns what closes them: Ghostty pids or Terminal window ids. */
async function launch(appKey, mode, count, seconds) {
	const argv = [process.execPath, SCRIPT, "--child", mode, String(seconds)];
	if (appKey === "ghostty") {
		const ghostty = () => new Set([...cpuTimes()].filter(([, row]) => isApp(row.args, "ghostty")).map(([pid]) => pid));
		const existing = ghostty();
		for (let index = 0; index < count; index++) {
			// -g -n: a new instance in the background, so no probe window takes focus.
			const opened = spawnSync("open", ["-g", "-n", "-a", "Ghostty", "--args", "-e", ...argv], { stdio: "inherit" });
			if (opened.status !== 0) throw new Error(`open Ghostty failed (exit ${opened.status})`);
		}
		for (let waited = 0; waited < 10_000; waited += 250) {
			const started = [...ghostty()].filter((pid) => !existing.has(pid));
			if (started.length >= count) return { pids: new Set(started) };
			await sleep(250);
		}
		throw new Error(`fewer than ${count} Ghostty windows started within 10 s`);
	}
	const windows = [];
	for (let index = 0; index < count; index++) {
		const command = `exec ${argv.map((part) => `'${part}'`).join(" ")}`;
		const script = `tell application "Terminal" to return id of (first window whose tabs contains (do script "${command.replaceAll('"', '\\"')}"))`;
		const id = execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
		if (!/^\d+$/.test(id)) throw new Error(`Terminal.app returned no window id (${id})`);
		windows.push(id);
	}
	return { windows };
}

/** Closes the windows `launch` opened, whether or not their sessions have exited. */
function close(opened) {
	for (const pid of opened.pids ?? []) {
		try {
			process.kill(pid, "SIGTERM");
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	}
	for (const id of opened.windows ?? []) {
		const script = `tell application "Terminal" to if exists window id ${id} then close window id ${id}`;
		spawnSync("osascript", ["-e", script], { stdio: "ignore" });
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (value) => `${value.toFixed(1)}%`;

function options(argv) {
	const appKey = argv[0];
	if (!(appKey in APPS))
		throw new UsageError(
			"usage: yarn measure:unfocused-cpu ghostty|terminal [--sessions 1,4,8] [--seconds 60] [--force]",
		);
	const value = (flag, fallback) => {
		const index = argv.indexOf(flag);
		return index === -1 ? fallback : argv[index + 1];
	};
	const sessions = value("--sessions", "1,4,8").split(",").map(Number);
	const seconds = Number(value("--seconds", "60"));
	if (sessions.some((n) => !Number.isInteger(n) || n < 1) || !(seconds > 0))
		throw new UsageError("--sessions takes counts like 1,4,8; --seconds a positive number");
	return { appKey, sessions, seconds, force: argv.includes("--force") };
}

async function main(argv) {
	if (argv[0] === "--child") return child(argv[1] ?? "animate", Number(argv[2] ?? 70));
	if (process.platform !== "darwin") throw new Error("This measurement drives Ghostty or Terminal.app on macOS.");
	const { appKey, sessions, seconds, force } = options(argv);
	const app = APPS[appKey];
	const load = loadavg()[0];
	if (load >= MAX_LOAD && !force) {
		process.stderr.write(
			`Load is ${load.toFixed(1)} (1 min), at least ${MAX_LOAD}: the numbers would be noise. Retry later or pass --force.\n`,
		);
		process.exitCode = 2;
		return;
	}
	const windowSeconds = Math.ceil(SETTLE_MS / 1000 + seconds + 5);
	// Ghostty probes are separate processes, measured alone; Terminal.app is one process, measured against its baseline.
	const minutes = Math.ceil(((seconds + 10) * (1 + sessions.length * 2) + sessions.length * 2 * 10) / 60);
	process.stdout.write(
		`${app.label}: ${sessions.join(", ")} sessions, ${seconds} s per sample, about ${minutes} min. Leave the new windows unfocused.\n`,
	);
	const baseline = appKey === "ghostty" ? undefined : await sample(app, seconds * 1000);
	if (baseline) process.stdout.write(`baseline: ${app.label} ${pct(baseline.terminal)}\n`);
	const results = [];
	for (const count of sessions) {
		const row = { count };
		for (const mode of ["animate", "paused"]) {
			const opened = await launch(appKey, mode, count, windowSeconds);
			try {
				await sleep(SETTLE_MS);
				row[mode] = await sample(app, seconds * 1000, opened.pids);
			} finally {
				close(opened);
			}
			process.stdout.write(
				`sessions=${count} mode=${mode} cpu=${pct(row[mode].terminal)} (sessions themselves ${pct(row[mode].sessions)})\n`,
			);
			await sleep(2_000);
		}
		results.push(row);
	}
	const scope = baseline ? "above its baseline" : "of the probe windows";
	process.stdout.write(`\n${app.label} CPU ${scope}, % of one core (the sessions' own CPU in brackets):\n`);
	for (const { count, animate, paused } of results) {
		const before = Math.max(0, animate.terminal - (baseline?.terminal ?? 0));
		const after = Math.max(0, paused.terminal - (baseline?.terminal ?? 0));
		const saved = before > 0 ? `${Math.round((1 - after / before) * 100)}% saved` : "no measurable cost";
		process.stdout.write(
			`  ${count} sessions: animate ${pct(before)} [${pct(animate.sessions)}], paused ${pct(after)} [${pct(paused.sessions)}]: ${saved}\n`,
		);
	}
}

class UsageError extends Error {}

try {
	await main(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof UsageError)) throw error;
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 2;
}
