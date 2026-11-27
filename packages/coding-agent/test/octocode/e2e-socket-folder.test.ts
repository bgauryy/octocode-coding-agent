import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/octocode/api/client.ts";
import { close, session } from "./e2e-a2a-helpers.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	type Sandbox,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * Where a session's API socket goes and who removes it: real processes, ended cleanly and by SIGKILL. A home deep enough
 * that the socket cannot sit beside its record is what every test sandbox has on macOS, and what any deep `HOME` has.
 */
let endpoint: Endpoint;
/** The sandboxes' temp directory, so what happens to a folder is this suite's doing: any session on the machine sweeps `/tmp`. */
let temp: string;
vi.setConfig({ testTimeout: 240_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
	temp = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "oc-e-"));
});
afterAll(async () => {
	await endpoint?.close();
	if (temp) fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
});

/** A sandbox whose home is too deep for a socket path; everything else the same. */
function deepSandbox(): Sandbox {
	const box = sandbox(endpoint);
	const deep = path.join(box.root, "d".repeat(70), "home");
	fs.mkdirSync(deep, { recursive: true });
	fs.cpSync(box.home, deep, { recursive: true });
	box.home = deep;
	box.env.HOME = deep;
	box.env.USERPROFILE = deep;
	box.env.TMPDIR = temp;
	return box;
}

const posix = process.platform !== "win32";
const socketOf = (each: Awaited<ReturnType<typeof session>>): string => each.instance.socket ?? "";

describe.runIf(posix)("the session API's socket", () => {
	it("in a short home sits beside its record and goes with a clean exit", async () => {
		const box = sandbox(endpoint);
		box.home = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "oc-e-"));
		const moved = box.home;
		fs.cpSync(path.join(box.root, "home"), moved, { recursive: true });
		box.env.HOME = moved;
		box.env.USERPROFILE = moved;
		try {
			const started = await session(box);
			const socket = socketOf(started);
			expect(path.dirname(socket)).toBe(path.join(moved, ".octocode", "octocodecode", "api"));
			await close(started);
			expect(fs.existsSync(socket)).toBe(false);
		} finally {
			// Descendants of the session may still be writing into its home: stop them before removing it.
			await killEverything();
			fs.rmSync(moved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it("in a deep home goes in an owner-named folder removed by a clean exit; one left by SIGKILL is swept by a later start in another home, and a live session's is not", async () => {
		// Each home is started once and never again, as with every test sandbox: no record will ever lead back to its folder.
		const killed = await session(deepSandbox());
		const killedFolder = path.dirname(socketOf(killed));
		const live = await session(deepSandbox());
		const liveFolder = path.dirname(socketOf(live));
		expect(path.dirname(liveFolder)).toBe(temp);
		expect(path.basename(liveFolder)).toMatch(new RegExp(`^octocode-\\d+-${live.instance.pid}-[A-Za-z0-9]{6}$`));
		expect(fs.statSync(liveFolder).mode & 0o777).toBe(0o700);
		killed.run.process.kill("SIGKILL");
		await killed.run.exited;
		expect(path.dirname(killedFolder)).toBe(temp);
		expect(fs.readdirSync(killedFolder)).toHaveLength(1);

		const later = await session(deepSandbox());
		await until(() => !fs.existsSync(killedFolder), "the sweep of the killed session's folder");
		// The session the sweep spared still answers on the same socket.
		expect((await new ApiClient(live.instance).call<{ sessionId: string }>("status")).sessionId).toBe(live.sessionId);
		expect(path.dirname(socketOf(live))).toBe(liveFolder);
		expect(path.dirname(socketOf(later))).not.toBe(killedFolder);
		await close(live, later);
		expect(fs.existsSync(liveFolder)).toBe(false);
	});
});
