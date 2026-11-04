import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	client,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
import { getCliInvocation } from "../src/config.ts";
import { ApiClient } from "../src/octocode/api/client.ts";
import { apiDir, listInstances } from "../src/octocode/api/registry.ts";
import { SCRIPTED_MODEL_ARGS, startModelServer, writeScriptedProvider } from "./helpers/feature-host-cli.ts";
import { trustFolder } from "./octocode/helpers.ts";

it("exchanges API messages on an ACP session and refuses overlapping ACP work without losing the session", async () => {
	const directory = mkdtempSync(join(tmpdir(), "octocode-acp-api-"));
	// The project is a subfolder: HOME is the temp directory, and Octocode refuses to open or trust a home folder.
	const project = join(directory, "project");
	mkdirSync(project);
	// A scripted OpenAI-compatible endpoint stands in for the model; `hold()` keeps a turn in flight until `release()`.
	const reply = { text: "API fixture reply" };
	const model = await startModelServer([reply, reply, reply, reply]);
	const agentDir = join(directory, "home");
	mkdirSync(agentDir);
	writeScriptedProvider({ agentDir }, model);
	model.hold();
	const env = {
		PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(process.platform === "win32" ? ";" : ":"),
		HOME: directory,
		USERPROFILE: directory,
		TMPDIR: tmpdir(),
		OCTOCODE_HOME: agentDir,
		OCTOCODE_CODING_AGENT_DIR: agentDir,
		OCTOCODE_AGENT_DB: join(directory, "agent.sqlite"),
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MCP: "0",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_API_HTTP: "0",
		OCTOCODE_PERMISSION: "full",
		OCTOCODE_MEMORY_AUTO: "0",
	};
	trustFolder(project, env);
	const invocation = getCliInvocation();
	const child = spawn(
		invocation.command,
		[
			...invocation.prefix,
			"--mode",
			"acp",
			"--no-mcp",
			"--no-skills",
			"--no-context-files",
			"--offline",
			...SCRIPTED_MODEL_ARGS,
		],
		{
			cwd: project,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		},
	);
	let diagnostics = "";
	child.stderr.on("data", (chunk) => {
		diagnostics += chunk.toString();
	});
	const exited = once(child, "close");
	const updates: SessionNotification[] = [];
	const connection = client({ name: "acp-api-test" })
		.onNotification(methods.client.session.update, ({ params }) => {
			updates.push(params);
		})
		.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
	const watchAbort = new AbortController();
	let watching: Promise<void> | undefined;
	try {
		await connection.agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = await connection.agent.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
		const instances = listInstances(apiDir(env));
		expect(instances, diagnostics).toHaveLength(1);
		const api = new ApiClient(instances[0]);
		await expect(api.call("status")).resolves.toMatchObject({ sessionId: session.sessionId });
		const events: string[] = [];
		const subscribed = Promise.withResolvers<void>();
		watching = api.watch(
			(event) => {
				events.push(event.type);
			},
			{
				signal: watchAbort.signal,
				onSubscribed: () => subscribed.resolve(),
			},
		);
		await Promise.race([subscribed.promise, watching]);
		const prompt = (text: string) =>
			connection.agent.request(methods.agent.session.prompt, {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text }],
			});
		const promptWhenReady = async (text: string) => {
			const deadline = Date.now() + 5_000;
			for (;;) {
				try {
					return await prompt(text);
				} catch (error) {
					if (
						!(error instanceof RequestError) ||
						error.message !== "Invalid request: Session is busy; nothing was sent." ||
						Date.now() >= deadline
					)
						throw error;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
			}
		};
		const sent = api.call<{ text: string }>("message.send", {
			text: "Reply from the external process",
			from: "acp-api-test",
			wait: true,
			key: "api-roundtrip",
			expectedSessionId: session.sessionId,
		});
		const outcome = sent.then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await vi.waitFor(() => expect(model.requests).toHaveLength(1));
		await expect(prompt("must not interrupt the external turn"), diagnostics).rejects.toThrow();
		model.release();
		const result = await outcome;
		expect(result, diagnostics).toEqual({
			value: expect.objectContaining({ text: expect.stringContaining("API fixture reply") }),
		});
		await vi.waitFor(() => expect(events, diagnostics).toContain("agent.settled"));
		expect(
			updates.some(
				({ update }) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("API fixture reply"),
			),
			diagnostics,
		).toBe(true);
		await expect(promptWhenReady("ACP remains usable"), diagnostics).resolves.toMatchObject({ stopReason: "end_turn" });
		model.hold();
		const cancelled = api.call("message.send", {
			text: "Wait for cancellation",
			from: "acp-api-test",
			wait: true,
			key: "api-cancellation",
			expectedSessionId: session.sessionId,
		});
		await vi.waitFor(() => expect(model.requests).toHaveLength(3));
		await connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
		await expect(cancelled, diagnostics).resolves.toMatchObject({ stopReason: "aborted" });
		expect(model.requests).toHaveLength(3);
		model.release();
		await expect(promptWhenReady("ACP remains usable after cancellation"), diagnostics).resolves.toMatchObject({
			stopReason: "end_turn",
		});
		expect(model.requests).toHaveLength(4);
		await connection.agent.request(methods.agent.session.close, { sessionId: session.sessionId });
		expect(listInstances(apiDir(env))).toEqual([]);
	} catch (error) {
		throw new Error(`ACP/API integration failed. Worker diagnostics:\n${diagnostics}`, { cause: error });
	} finally {
		model.release();
		watchAbort.abort();
		await watching?.catch(() => {});
		connection.close();
		child.stdin.end();
		await exited;
		await model.close();
		rmSync(directory, { recursive: true, force: true });
	}
}, 60_000);
