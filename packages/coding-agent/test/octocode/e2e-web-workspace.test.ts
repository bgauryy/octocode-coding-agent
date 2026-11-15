import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { APPLICATION_PROTOCOL_VERSION, type ApplicationAwaiting } from "@octocodeai/octocode-contracts";
import { daemonRequest, findWebDaemon, type LaunchedDaemon } from "../../src/octocode/web-daemon/launcher.ts";
import { seedTrust } from "./e2e-helpers/seed-trust.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	type Run,
	sandbox,
	type Sandbox,
	script,
	startEndpoint,
	type Step,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * Answering a dialog from the web workspace, through real processes: a `workspace`-mode RPC session on a scripted model
 * attaches to the user-level web daemon (`/web`), and the test is the browser: it reads the application stream over the
 * daemon's socket and posts the `answer` command with the launch token (a control tab) or a view-only token.
 */
let endpoint: Endpoint;
vi.setConfig({ testTimeout: 240_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});

const daemons: LaunchedDaemon[] = [];
const sockets: WebSocket[] = [];
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	for (const socket of sockets.splice(0)) socket.terminate();
	// The daemon outlives its session by design: stop it so no process is left behind.
	for (const daemon of daemons.splice(0)) await daemonRequest(daemon, "/api/admin/drain", { method: "POST" });
	await killEverything();
	endpoint.requests.length = 0;
});

const WAIT = 120_000;

interface Tab {
	/** The dialog the stream says the session waits on now, if any. */
	awaiting(): ApplicationAwaiting | undefined;
}

interface Workspace {
	box: Sandbox;
	run: Run;
	daemon: LaunchedDaemon;
	sessionId: string;
	tab: Tab;
	/** Starts a turn with a scripted model, as the terminal's user typing a prompt would. */
	prompt(steps: Step[]): void;
	/** POSTs an application command to the session through the daemon; `token` defaults to the launch capability. */
	answer(awaiting: ApplicationAwaiting, choice: string, token?: string): Promise<{ status: number; body: unknown }>;
	viewToken(): Promise<string>;
}

function post(daemon: LaunchedDaemon, route: string, token: string, body: unknown) {
	return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
		const origin = new URL(daemon.origin);
		const payload = Buffer.from(JSON.stringify(body));
		const request = http.request(
			{
				host: origin.hostname,
				port: origin.port,
				path: route,
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"content-length": payload.length,
				},
				agent: new http.Agent({ keepAlive: false }),
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
				});
			},
		);
		request.on("error", reject);
		request.end(payload);
	});
}

/** A full session in `workspace` mode that has opened `/web`, with a tab reading its application stream. */
async function openWorkspace(): Promise<Workspace> {
	const box = sandbox(endpoint);
	seedTrust(box);
	Object.assign(box.env, {
		OCTOCODE_HOME: path.join(box.home, ".octocode", "octocodecode"),
		OCTOCODE_WEB_DAEMON_IDLE_MINUTES: "5",
		// Over SSH the page's address is printed, so no browser window opens on this machine.
		SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22",
	});
	const run = box.start(["--mode", "rpc", "--permission-mode", "workspace"], { stdin: "pipe" });
	const send = (command: Record<string, unknown>) => run.process.stdin?.write(`${JSON.stringify(command)}\n`);
	send({ type: "prompt", message: "/web item B1" });
	let found: LaunchedDaemon | undefined;
	await until(
		() => {
			void findWebDaemon(box.env).then((daemon) => (found = daemon));
			return found !== undefined;
		},
		"the web daemon",
		WAIT,
	);
	const daemon = found!;
	daemons.push(daemon);
	let sessionId = "";
	await until(
		() => {
			void daemonRequest(daemon, "/api/sessions").then((answer) => {
				const sessions = (answer?.json() as { sessions?: Array<{ id: string }> } | undefined)?.sessions ?? [];
				if (sessions.length) sessionId = sessions[0].id;
			});
			return sessionId !== "";
		},
		"the session to attach to the daemon",
		WAIT,
	);

	// The tab: the daemon's live socket, authenticated by its hello, and every application frame it sends.
	const frames: Array<Record<string, any>> = [];
	const socket = new WebSocket(`ws://${new URL(daemon.origin).host}/s/${sessionId}/api/backlogs/live`, {
		headers: { origin: daemon.origin },
	});
	sockets.push(socket);
	socket.on("message", (data) => {
		const packet = JSON.parse(data.toString()) as { type: string; data: Record<string, any> };
		if (packet.type === "application") frames.push(packet.data);
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	socket.send(JSON.stringify({ token: daemon.token, protocolVersion: APPLICATION_PROTOCOL_VERSION }));

	const tab: Tab = {
		awaiting() {
			let current: ApplicationAwaiting | undefined;
			for (const frame of frames) {
				if (frame.type === "snapshot") current = frame.snapshot.awaiting;
				else if (frame.type === "event" && frame.event.type === "session.awaiting") current = frame.event.awaiting;
			}
			return current;
		},
	};
	let counter = 0;
	return {
		box,
		run,
		daemon,
		sessionId,
		tab,
		prompt: (steps) => send({ type: "prompt", message: `Please do it. ${script(steps)}` }),
		answer: (awaiting, choice, token = daemon.token) =>
			post(daemon, `/s/${sessionId}/api/application`, token, {
				id: `web-answer-${++counter}`,
				sessionId,
				action: "answer",
				dialogId: awaiting.id,
				// The dialog is one typed question: reply with the option whose label is `choice`, by its id.
				replies: [{ id: awaiting.questions![0].id, picks: [optionId(awaiting, choice)] }],
			}),
		viewToken: async () => {
			const published = await post(daemon, "/api/admin/remote", daemon.token, { transport: "ssh", access: "view" });
			expect(published.status).toBe(200);
			const { url } = (published.body as { link: { url: string } }).link;
			return new URLSearchParams(new URL(url).hash.slice(1)).get("access")!;
		},
	};
}

/** The id of the first question's option whose label contains `label`. */
const optionId = (awaiting: ApplicationAwaiting, label: string): string => {
	const option = awaiting.questions?.[0]?.options?.find((candidate) => candidate.label.includes(label));
	if (!option) throw new Error(`no option "${label}" in ${JSON.stringify(awaiting.questions)}`);
	return option.id;
};

const waitingOn = async (workspace: Workspace, what: string) => {
	await until(() => workspace.tab.awaiting()?.id !== undefined, what, WAIT);
	return workspace.tab.awaiting()!;
};

const toolResults = () => endpoint.requests.flatMap((request) => request.toolResults);

describe("a dialog answered from the web workspace", () => {
	it("shows a bash ask as awaiting; Allow once over HTTP runs the command and the model sees its output", async () => {
		const workspace = await openWorkspace();
		const marker = path.join(workspace.box.root, "ran-after-allow.txt");
		workspace.prompt([
			{ tool: "bash", args: { command: `touch ${marker} && echo web-allowed-output` } },
			{ text: "the command finished" },
		]);

		const awaiting = await waitingOn(workspace, "the bash ask in the web stream");
		expect(awaiting.kind).toBe("approval");
		expect(awaiting.questions?.[0]?.options?.map((option) => option.label)).toContain("Allow once");
		expect(awaiting.title).toBeTruthy();
		// Nothing runs while the dialog waits.
		expect(fs.existsSync(marker)).toBe(false);

		const answered = await workspace.answer(awaiting, "Allow once");
		expect(answered.status, JSON.stringify(answered.body)).toBe(200);
		expect(answered.body).toMatchObject({ receipt: { status: "accepted" } });

		await until(() => toolResults().some((result) => result.includes("web-allowed-output")), "the tool result", WAIT);
		expect(fs.existsSync(marker)).toBe(true);
		await until(() => workspace.tab.awaiting() === undefined, "the dialog to close in the stream", WAIT);
	});

	it("refuses an answer from a view-only token: the dialog stays and the command never runs", async () => {
		const workspace = await openWorkspace();
		const marker = path.join(workspace.box.root, "ran-after-view.txt");
		workspace.prompt([
			{ tool: "bash", args: { command: `touch ${marker} && printf '%s-%s-%s\\n' view only output` } },
			{ text: "the command finished" },
		]);
		const awaiting = await waitingOn(workspace, "the bash ask in the web stream");
		const view = await workspace.viewToken();

		const refused = await workspace.answer(awaiting, "Allow once", view);
		expect(refused.status).toBe(403);
		expect(JSON.stringify(refused.body)).toMatch(/view-only/);
		expect(workspace.tab.awaiting()?.id).toBe(awaiting.id);
		expect(fs.existsSync(marker)).toBe(false);
		expect(toolResults()).toEqual([]);

		// A control tab then denies it: the model is told, and the command still never ran.
		const denied = await workspace.answer(awaiting, "Deny");
		expect(denied.status, JSON.stringify(denied.body)).toBe(200);
		await until(() => toolResults().length > 0, "the denied tool result", WAIT);
		expect(toolResults().join("\n")).not.toContain("view-only-output");
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("completes a single-choice askUser turn from the web, and the model receives the choice", async () => {
		const workspace = await openWorkspace();
		workspace.prompt([
			{
				tool: "askUser",
				args: {
					questions: [
						{
							question: "Which colour should the badge be?",
							options: [{ label: "Teal" }, { label: "Orange" }],
						},
					],
				},
			},
			{ text: "badge colour settled" },
		]);

		const awaiting = await waitingOn(workspace, "the question in the web stream");
		expect(awaiting.kind).toBe("question");
		expect(awaiting.title).toContain("Which colour should the badge be?");
		expect(awaiting.questions?.[0]?.options?.map((option) => option.label)).toContain("Orange");

		const answered = await workspace.answer(awaiting, "Orange");
		expect(answered.status, JSON.stringify(answered.body)).toBe(200);

		// The turn ends with the model's last scripted text, after it was sent the answer.
		await until(() => endpoint.requests.some((request) => request.step === 1), "the model's second request", WAIT);
		const result = toolResults().join("\n");
		expect(result).toContain("Which colour should the badge be?");
		expect(result).toContain("Orange");
		expect(result).not.toContain("Teal");
		await until(() => workspace.tab.awaiting() === undefined, "the dialog to close in the stream", WAIT);
	});
});
