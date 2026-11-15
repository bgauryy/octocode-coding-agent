import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ClientConnection, methods } from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
import { AcpBackend } from "../../src/client/client.ts";
import { acpClientHost } from "../../../coding-agent/src/octocode/external/acp-host.ts";
import { processAlive } from "../../../coding-agent/src/octocode/shared/process.ts";
import { readProcessTable } from "../../../coding-agent/src/octocode/shared/process-table.ts";

const sdk = createRequire(import.meta.url).resolve("@agentclientprotocol/sdk");
const deny = async () => ({ outcome: { outcome: "cancelled" as const } });
function peer(mode: string) {
	const root = fs.mkdtempSync(path.join(tmpdir(), "acp-shutdown-"));
	const journal = path.join(root, "events.jsonl"),
		script = path.join(root, "peer.mjs");
	fs.writeFileSync(
		script,
		`
import fs from 'node:fs';import {spawn}from'node:child_process';import{Readable,Writable}from'node:stream';
const{agent,methods,ndJsonStream,PROTOCOL_VERSION}=await import(${JSON.stringify(sdk)});
const record=event=>fs.appendFileSync(${JSON.stringify(journal)},JSON.stringify(event)+'\\n');
const app=agent({name:'owned-shutdown-peer'})
.onRequest(methods.agent.initialize,()=>({protocolVersion:PROTOCOL_VERSION,agentCapabilities:{sessionCapabilities:{close:{}}}}))
.onRequest(methods.agent.session.new,async()=>{const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});helper.unref();await new Promise(resolve=>helper.once('spawn',resolve));record({event:'ready',root:process.pid,helper:helper.pid});return{sessionId:'owned-session'};})
.onRequest(methods.agent.session.prompt,({signal})=>{record({event:'prompt'});signal.addEventListener('abort',()=>record({event:'protocol-cancel'}));return new Promise(()=>{});})
.onRequest(methods.agent.session.load,()=>{record({event:'barrier'});return{};})
.onNotification(methods.agent.session.cancel,()=>record({event:'cancel'}))
.onRequest(methods.agent.session.close,()=>{record({event:'close'});if(${JSON.stringify(mode)}==='reject')throw new Error('close rejected');process.exit(0);});
app.connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
`,
	);
	const events = (): Array<{ event: string; root?: number; helper?: number }> =>
		fs.existsSync(journal)
			? fs
					.readFileSync(journal, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
	const input = { command: process.execPath, args: [script], vendor: "fixture", cwd: root, timeoutMs: 5_000 };
	return { root, events, input };
}

async function cleanup(
	fixture: ReturnType<typeof peer>,
	backend: AcpBackend | undefined,
	identities: Map<number, string | undefined>,
) {
	try {
		await backend?.close();
		const table = await readProcessTable();
		for (const [pid, started] of identities)
			if (started && table?.rows.get(pid)?.started === started) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			}
		await vi.waitFor(() => expect([...identities.keys()].filter(processAlive)).toEqual([]), { timeout: 2_000 });
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
}

it.skipIf(process.platform === "win32").each(["exit", "reject"])(
	"closes and drains a detached helper when session/close makes its peer %s",
	async (mode) => {
		const fixture = peer(mode);
		let backend: AcpBackend | undefined;
		const identities = new Map<number, string | undefined>();
		try {
			backend = await AcpBackend.connect(acpClientHost, fixture.input, deny);
			const ready = fixture.events().find((event) => event.event === "ready")!;
			const before = await readProcessTable();
			for (const pid of [ready.root!, ready.helper!]) identities.set(pid, before?.rows.get(pid)?.started);
			expect(before?.rows.get(ready.helper!)?.ppid).toBe(ready.root);
			await backend.close();
			expect(fixture.events().filter((event) => event.event === "close")).toHaveLength(1);
			expect([ready.root!, ready.helper!].filter(processAlive)).toEqual([]);
		} finally {
			await cleanup(fixture, backend, identities);
		}
	},
	20_000,
);

it.skipIf(process.platform === "win32")(
	"invalidates a caller-aborted turn locally while protocol cancellation waits for ownership capture",
	async () => {
		const fixture = peer("exit");
		let backend: AcpBackend | undefined;
		const identities = new Map<number, string | undefined>();
		let release!: () => void, admitted!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const capturing = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		let stops = 0;
		const host = {
			...acpClientHost,
			processTree: {
				...acpClientHost.processTree,
				stop: async (pid: number | undefined, graceful?: () => Promise<void>) => {
					stops++;
					admitted();
					await barrier;
					await acpClientHost.processTree.stop(pid, graceful);
				},
			},
		};
		let work: Promise<unknown> | undefined;
		try {
			backend = await AcpBackend.connect(host, fixture.input, deny);
			const ready = fixture.events().find((event) => event.event === "ready")!,
				before = await readProcessTable();
			for (const pid of [ready.root!, ready.helper!]) identities.set(pid, before?.rows.get(pid)?.started);
			const controller = new AbortController();
			work = backend.prompt("wait", { signal: controller.signal, timeoutMs: 5_000 }).catch((error) => error);
			await vi.waitFor(() => expect(fixture.events().some((event) => event.event === "prompt")).toBe(true));
			controller.abort();
			await capturing;
			const internal = backend as unknown as { active: { signal: AbortSignal }; connection: ClientConnection };
			expect(internal.active.signal.aborted).toBe(true);
			// A round trip on the same ordered transport drains any protocol cancellation already sent before capture.
			await internal.connection.agent.request(methods.agent.session.load, {
				sessionId: backend.sessionId,
				cwd: fixture.root,
				mcpServers: [],
			});
			expect(fixture.events().map((event) => event.event)).not.toContain("protocol-cancel");
			expect(fixture.events().map((event) => event.event)).not.toContain("cancel");
			release();
			expect(await work).toHaveProperty("message", expect.stringContaining("ACP prompt failed"));
			await Promise.all([backend.cancel(), backend.close()]);
			expect(stops).toBe(1);
			expect([ready.root!, ready.helper!].filter(processAlive)).toEqual([]);
		} finally {
			release();
			await work;
			await cleanup(fixture, backend, identities);
		}
	},
	20_000,
);
