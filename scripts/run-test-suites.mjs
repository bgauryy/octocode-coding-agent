import { constants } from "node:os";
import { spawnYarn } from "./yarn-command.mjs";

const cancellationSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
const signalStatus = (signal) => 128 + constants.signals[signal];

/** Supervise one Yarn command, including prerequisite discovery, until its process tree has stopped. */
export async function runTestCommand(args, { captureOutput = false } = {}) {
	// Nested runners share their outer suite's group, so cancelling the outer runner also reaches their workers.
	const ownsGroup = process.platform !== "win32" && process.env.OCTOCODE_TEST_SUITE_CHILD !== "1";
	let active;
	let cancelled;
	let killTimer;
	let output = "";
	const sendSignal = (signal) => {
		if (!active?.pid) return;
		try {
			if (ownsGroup) process.kill(-active.pid, signal);
			else active.kill(signal);
		} catch (error) {
			if (error.code !== "ESRCH") console.error(error);
		}
	};
	const cancel = (signal) => {
		if (cancelled) return;
		cancelled = signal;
		sendSignal(signal);
		killTimer = setTimeout(() => sendSignal("SIGKILL"), 5000);
		killTimer.unref();
	};
	const listeners = cancellationSignals.map((signal) => {
		const listener = () => cancel(signal);
		process.on(signal, listener);
		return [signal, listener];
	});
	try {
		const result = await new Promise((done) => {
			active = spawnYarn(args, {
				stdio: captureOutput ? ["inherit", "pipe", "inherit"] : "inherit",
				detached: ownsGroup,
				env: { ...process.env, OCTOCODE_TEST_SUITE_CHILD: "1" },
			});
			active.stdout?.on("data", (chunk) => {
				output += chunk;
			});
			let spawnError;
			active.once("error", (error) => {
				spawnError = error;
				console.error(error);
			});
			active.once("close", (code, signal) => done({ code, signal, spawnError }));
		});
		// Yarn can translate a child's signal into the conventional numeric status.
		const signal = result.signal ?? cancellationSignals.find((each) => signalStatus(each) === result.code);
		if (signal) cancel(signal);
		// The Yarn process may exit before a descendant that ignored the initial signal.
		if (cancelled) sendSignal("SIGKILL");
		return {
			code: cancelled ? signalStatus(cancelled) : result.spawnError ? 1 : (result.code ?? 1),
			signal: cancelled,
			output,
		};
	} finally {
		for (const [signal, listener] of listeners) process.off(signal, listener);
		clearTimeout(killTimer);
	}
}

/** Run every suite after ordinary failures, stopping immediately on cancellation. */
export async function runTestSuites(suites) {
	const failed = [];
	let passed = 0;
	let cancelled;
	for (const suite of suites) {
		console.log(`\n==> ${suite.label}`);
		const result = await runTestCommand(suite.args);
		if (result.signal) {
			cancelled = result.signal;
			break;
		}
		if (result.code === 0) passed++;
		else failed.push(suite.label);
	}
	console.log(`\n${passed}/${String(suites.length)} test suites passed.`);
	if (failed.length > 0) console.error(`Failed: ${failed.join(", ")}`);
	if (cancelled) {
		console.error("Cancelled:", cancelled);
		return signalStatus(cancelled);
	}
	return failed.length > 0 ? 1 : 0;
}
