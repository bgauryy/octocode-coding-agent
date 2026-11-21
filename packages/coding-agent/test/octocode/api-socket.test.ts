import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/octocode/api/events.ts";
import { newInstanceId, removeSocket, socketPath, sweepSocketFolders } from "../../src/octocode/api/registry.ts";
import { ApiServer } from "../../src/octocode/api/server.ts";
import { tmp } from "./helpers.ts";

const posix = process.platform !== "win32";
const servers: ApiServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});
const serve = () => {
	const server = new ApiServer(() => Promise.resolve(undefined), new EventLog(), "token");
	servers.push(server);
	return server;
};

describe.runIf(posix)("api socket overload", () => {
	it("rejects excess peers and closes even when a rejected peer stays open", async () => {
		let dispatches = 0;
		const server = new ApiServer(async () => ++dispatches, new EventLog(), "token");
		servers.push(server);
		const file = socketPath(tmp("octo-overload-"), "s");
		await server.listenUnix(file);
		const peers: net.Socket[] = [];
		const connect = async (): Promise<net.Socket> => {
			const peer = net.createConnection({ path: file, allowHalfOpen: true });
			peers.push(peer);
			peer.on("error", () => {});
			await new Promise<void>((resolve, reject) => {
				peer.once("connect", resolve);
				peer.once("error", reject);
			});
			return peer;
		};
		const request = (peer: net.Socket, id: number): Promise<{ result?: number; error: { message: string } }> =>
			new Promise((resolve) => {
				peer.once("data", (data) => resolve(JSON.parse(data.toString())));
				peer.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "test" })}\n`);
			});
		try {
			for (let i = 0; i < 16; i++) {
				const peer = await connect();
				expect((await request(peer, i)).result).toBe(i + 1);
			}
			const rejected = await connect();
			const response = await request(rejected, 17);
			expect(response.error.message).toBe("Too many connections");
			expect(dispatches).toBe(16);
			// Abruptly disconnect an excess peer while the server may be writing its rejection.
			const reset = await connect();
			reset.destroy();
			const freed = peers[0];
			const ended = new Promise<void>((resolve) => freed.once("end", resolve));
			freed.end();
			await ended;
			const recovered = await connect();
			expect((await request(recovered, 18)).result).toBe(17);
			expect(dispatches).toBe(17);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					server.close(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("server close timed out")), 500);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		} finally {
			for (const peer of peers) peer.destroy();
		}
	});
});

describe.runIf(posix)("api socket idle deadline", () => {
	it("closes peers that send no complete frame so later requests are served", async () => {
		const server = new ApiServer(async () => "ok", new EventLog(), "token", undefined, 150);
		servers.push(server);
		const file = socketPath(tmp("octo-idle-"), "s");
		await server.listenUnix(file);
		const peers: net.Socket[] = [];
		const connect = async (): Promise<net.Socket> => {
			const peer = net.createConnection({ path: file });
			peers.push(peer);
			peer.on("error", () => {});
			await new Promise<void>((resolve) => peer.once("connect", resolve));
			return peer;
		};
		try {
			const silent = [];
			for (let i = 0; i < 16; i++) silent.push(await connect());
			silent[0].write('{"jsonrpc":"2.0"'); // half a frame
			await Promise.all(silent.map((peer) => new Promise<void>((resolve) => peer.once("close", () => resolve()))));
			const peer = await connect();
			const reply = new Promise<{ result?: string }>((resolve) =>
				peer.once("data", (data) => resolve(JSON.parse(data.toString()))),
			);
			peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message.send" })}\n`);
			expect((await reply).result).toBe("ok");
			// After its request, a quiet connection is left alone.
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(peer.destroyed).toBe(false);
		} finally {
			for (const peer of peers) peer.destroy();
		}
	});
});

describe("api instance ids", () => {
	it("are Octocode's own and unique", () => {
		expect(newInstanceId()).toMatch(/^oc-[0-9a-f]{6}$/);
		expect(newInstanceId()).not.toBe(newInstanceId());
	});
});

describe.runIf(posix)("api socket permissions", () => {
	it("makes the socket owner-only from the bind, whatever the umask, and restores the umask", async () => {
		const before = process.umask(0o000);
		try {
			const file = socketPath(tmp("octo-sock-"), "s");
			const listening = serve().listenUnix(file);
			// Synchronously after `listen`, before its callback: no window in which group or other could connect.
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			await listening;
			// oxlint-disable-next-line typescript/no-deprecated -- reads the process umask to prove the bind restored it
			expect(process.umask()).toBe(0o000);
		} finally {
			process.umask(before);
		}
	});

	it("puts a long path's socket in a private mkdtemp folder, and removes the folder with the socket", async () => {
		const file = socketPath(`/${"x".repeat(120)}`, "pi-3");
		const folder = path.dirname(file);
		expect(Buffer.byteLength(file)).toBeLessThanOrEqual(100);
		expect(path.basename(folder)).toMatch(new RegExp(`^octocode-\\d+-${process.pid}-[A-Za-z0-9]{6}$`));
		expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
		// Another call gets another folder: the name is not guessable or shared.
		const second = socketPath(`/${"x".repeat(120)}`, "pi-3");
		expect(path.dirname(second)).not.toBe(folder);
		removeSocket(second);
		const server = serve();
		await server.listenUnix(file);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		await server.close();
		expect(fs.existsSync(folder)).toBe(false);
		expect(fs.existsSync(path.dirname(second))).toBe(false);
	});

	it("binds and cleans up a short private socket when TMPDIR is also too deep", async () => {
		const temp = path.join(tmp("octo-deep-"), "nested".repeat(25));
		fs.mkdirSync(temp);
		const file = socketPath(temp, "octocode-test", { TMPDIR: temp });
		expect(Buffer.byteLength(file)).toBeLessThanOrEqual(100);
		expect(path.dirname(path.dirname(file))).toBe(fs.realpathSync("/tmp"));
		expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		const server = serve();
		await server.listenUnix(file);
		await server.close();
		expect(fs.existsSync(path.dirname(file))).toBe(false);
	});

	it("removes only the socket file when it sits next to its record", () => {
		const dir = tmp("octo-sock-");
		const file = path.join(dir, "pi-1.sock");
		fs.writeFileSync(file, "");
		removeSocket(file);
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(dir)).toBe(true);
	});

	it("removes the folder when the bind fails, so a session that could not start leaves nothing", async () => {
		const file = socketPath(`/${"x".repeat(120)}`, "oc-abc123");
		const folder = path.dirname(file);
		fs.chmodSync(folder, 0o500);
		const server = serve();
		await expect(server.listenUnix(file)).rejects.toThrow();
		fs.chmodSync(folder, 0o700);
		await server.close();
		expect(fs.existsSync(folder)).toBe(false);
	});
});

describe.runIf(posix)("sweeping fallback socket folders", () => {
	const uid = process.getuid?.() ?? 0;
	/** A pid that was real and has exited. */
	const deadPid = (): number => {
		const { pid } = spawnSync(process.execPath, ["-e", ""]);
		return pid;
	};
	const folder = (root: string, name: string): string => {
		const made = path.join(root, name);
		fs.mkdirSync(made, { mode: 0o700 });
		return made;
	};
	/** A socket left by a process that was killed: the file stays and nothing listens. */
	const killedSocket = (dir: string, name = "oc-abc123.sock"): string => {
		const file = path.join(dir, name);
		spawnSync(process.execPath, [
			"-e",
			"require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
			file,
		]);
		expect(fs.lstatSync(file).isSocket()).toBe(true);
		return file;
	};
	/** A short root, since the socket paths must bind. */
	const shortRoot = (): string => fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "oc-t-"));
	const roots: string[] = [];
	const root = (): string => {
		const made = shortRoot();
		roots.push(made);
		return made;
	};
	afterEach(() => {
		for (const each of roots.splice(0)) fs.rmSync(each, { recursive: true, force: true });
	});

	it("removes a dead owner's socket and folder", async () => {
		const base = root();
		const dead = folder(base, `octocode-${uid}-${deadPid()}-AbCdE1`);
		killedSocket(dead);
		expect(await sweepSocketFolders({}, [base])).toBe(1);
		expect(fs.readdirSync(base)).toEqual([]);
	});

	it("never touches a live session's socket", async () => {
		const base = root();
		const earlier = folder(base, `octocode-${uid}-${deadPid()}-AbCdE3`);
		const server = serve();
		await server.listenUnix(path.join(earlier, "oc-abc123.sock"));
		// A pid this process cannot see is dead to it, as in another pid namespace sharing the temp directory: its socket still answers.
		const otherNamespace = folder(base, `octocode-${uid}-${deadPid()}-AbCdE4`);
		const listener = net.createServer();
		await new Promise<void>((resolve) => listener.listen(path.join(otherNamespace, "oc-abc124.sock"), resolve));
		expect(await sweepSocketFolders({}, [base])).toBe(0);
		expect(fs.existsSync(path.join(earlier, "oc-abc123.sock"))).toBe(true);
		expect(fs.existsSync(path.join(otherNamespace, "oc-abc124.sock"))).toBe(true);
		await new Promise((resolve) => listener.close(resolve));
	});

	it("keeps a folder whose owner pid is alive even when its socket refuses: it may be between bind and listen", async () => {
		const base = root();
		const live = folder(base, `octocode-${uid}-${process.pid}-AbCdE5`);
		killedSocket(live);
		const liveEmpty = folder(base, `octocode-${uid}-${process.pid}-AbCdE6`);
		expect(await sweepSocketFolders({}, [base])).toBe(0);
		expect(fs.readdirSync(live)).toEqual(["oc-abc123.sock"]);
		expect(fs.existsSync(liveEmpty)).toBe(true);
	});

	it("takes pid 1, always alive, as no proof either way: the socket decides", async () => {
		const base = root();
		const refused = folder(base, `octocode-${uid}-1-AbCdEh`);
		killedSocket(refused);
		const answering = folder(base, `octocode-${uid}-1-AbCdEi`);
		const server = serve();
		await server.listenUnix(path.join(answering, "oc-abc123.sock"));
		const empty = folder(base, `octocode-${uid}-1-AbCdEj`);
		expect(await sweepSocketFolders({}, [base])).toBe(1);
		expect(fs.existsSync(refused)).toBe(false);
		expect(fs.existsSync(path.join(answering, "oc-abc123.sock"))).toBe(true);
		expect(fs.existsSync(empty)).toBe(true);
	});

	it("removes an empty folder whose named owner is gone", async () => {
		const base = root();
		const gone = folder(base, `octocode-${uid}-${deadPid()}-AbCdE7`);
		expect(await sweepSocketFolders({}, [base])).toBe(1);
		expect(fs.existsSync(gone)).toBe(false);
	});

	it("leaves everything it cannot prove its own", async () => {
		const base = root();
		const names = {
			otherUser: folder(base, `octocode-${uid + 1}-AbCdE9`),
			otherShape: folder(base, `octocode-${uid}-toolongname`),
			notOurs: folder(base, "someone-else-AbCdEf"),
			foreignFile: folder(base, `octocode-${uid}-${deadPid()}-AbCdEa`),
			foreignSocket: folder(base, `octocode-${uid}-${deadPid()}-AbCdEb`),
			extraFile: folder(base, `octocode-${uid}-${deadPid()}-AbCdEc`),
			notSocket: folder(base, `octocode-${uid}-${deadPid()}-AbCdEd`),
			open: folder(base, `octocode-${uid}-${deadPid()}-AbCdEe`),
		};
		for (const each of [names.otherUser, names.otherShape, names.notOurs]) killedSocket(each);
		fs.writeFileSync(path.join(names.foreignFile, "notes.txt"), "x");
		killedSocket(names.foreignSocket, "other.sock");
		killedSocket(names.extraFile);
		fs.writeFileSync(path.join(names.extraFile, "notes.txt"), "x");
		fs.writeFileSync(path.join(names.notSocket, "oc-abc123.sock"), "x");
		killedSocket(names.open);
		fs.chmodSync(names.open, 0o755);
		const target = root();
		killedSocket(target);
		fs.symlinkSync(target, path.join(base, `octocode-${uid}-${deadPid()}-AbCdEg`));
		expect(await sweepSocketFolders({}, [base])).toBe(0);
		for (const each of Object.values(names)) expect(fs.existsSync(each)).toBe(true);
		expect(fs.readdirSync(target)).toEqual(["oc-abc123.sock"]);
	});

	it("says nothing and removes nothing when a root cannot be read", async () => {
		expect(await sweepSocketFolders({}, ["/no/such/folder"])).toBe(0);
	});
});
