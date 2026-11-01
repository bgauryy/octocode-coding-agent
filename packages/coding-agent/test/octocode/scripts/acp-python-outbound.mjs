import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(process.env.HOME, config.cwd);
assert.equal(process.env.OCTOCODE_HOME, config.env.OCTOCODE_HOME);
assert.equal(process.env.OCTOCODE_ACP_PARENT_ONLY, undefined);
await import(config.resolver);
const { AcpBackend } = await import(join(config.packageDir, "../acp/src/client/client.ts"));
const { acpClientHost } = await import(join(config.packageDir, "src/octocode/external/acp-host.ts"));
const { processAlive } = await import(join(config.packageDir, "src/octocode/shared/process.ts"));
const stop = new AbortController();
const interrupt = () => stop.abort(new Error("Interrupted"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
const backends = [];
const peerPids = [];
const checks = [];
let permissions = 0;
try {
	const connect = async (sessionId) => {
		const pidFile = join(config.cwd, `peer-${backends.length}.pid`);
		const backend = await AcpBackend.connect(
			acpClientHost,
			{
				command: config.python,
				args: [config.peer, "agent", pidFile],
				cwd: config.cwd,
				vendor: "python-interop-fixture",
				sessionId,
				timeoutMs: 15_000,
			},
			async (request) => {
				permissions++;
				assert.equal(request.toolCall.toolCallId, "write-1");
				return { outcome: { outcome: "selected", optionId: "reject" } };
			},
			stop.signal,
		);
		backends.push(backend);
		peerPids.push(Number(readFileSync(pidFile, "utf8")));
		return backend;
	};
	const backend = await connect();
	const prompt = (text) => backend.prompt(text, { timeoutMs: 10_000, signal: stop.signal });
	assert.equal((await prompt("héllo 🐙\nline")).text, "turn 1: héllo 🐙\nline");
	assert.equal((await prompt("again")).text, "turn 2: again");
	checks.push("Python initialize/new/stateful Unicode replies");
	assert.match((await prompt("permission")).text, /"optionId":"reject"/);
	assert.equal(permissions, 1);
	checks.push("Python permission request and explicit rejection");
	const loaded = await connect("python-saved");
	assert.equal((await loaded.prompt("resumed", { timeoutMs: 10_000, signal: stop.signal })).text, "turn 11: resumed");
	checks.push("Python advertised session/load");
	const timedOut = await backend.prompt("wait", { timeoutMs: 200, signal: stop.signal }).catch((error) => error);
	assert.equal(timedOut.execution, "uncertain");
	assert.equal(timedOut.partial.text, "turn 4: wait");
	await backend.cancel();
	assert(backend.isClosed);
	await assert.rejects(prompt("never replay"), { execution: "not-sent" });
	checks.push("timeout evidence, cancellation, and no automatic replay");
} catch (error) {
	console.error(JSON.stringify({ completedChecks: checks, diagnostics: error?.stderr }));
	throw error;
} finally {
	const closed = await Promise.allSettled(backends.map((backend) => backend.close()));
	for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
	assert(
		closed.every((result) => result.status === "fulfilled"),
		"Outbound backend cleanup failed.",
	);
	assert(
		backends.every((backend) => backend.isClosed),
		"Outbound backend remains open.",
	);
	assert(
		peerPids.every((pid) => !processAlive(pid)),
		"Outbound Python peer remains alive.",
	);
}
console.log(JSON.stringify({ checks, isolatedEnvironment: true, backendsClosed: true, peerProcessesStopped: true }));
