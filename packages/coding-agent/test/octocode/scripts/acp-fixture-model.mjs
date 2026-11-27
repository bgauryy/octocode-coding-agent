import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

/** Provider and model the ACP interoperability scripts select with `--provider` and `--model`. */
export const FIXTURE_PROVIDER = "acp-compatibility-fixture";
export const FIXTURE_MODEL = "fixture";

const REPLY_DELAY_MS = 1500;

const chunk = (delta, finish) =>
	`data: ${JSON.stringify({
		id: "fixture",
		object: "chat.completion.chunk",
		created: 0,
		model: FIXTURE_MODEL,
		choices: [{ index: 0, delta, finish_reason: finish }],
	})}\n\n`;

function lastUserText(body) {
	const message = (body?.messages ?? []).findLast((candidate) => candidate.role === "user");
	if (typeof message?.content === "string") return message.content;
	return (message?.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/**
 * Offline model for exercising the real CLI with independent ACP clients: an OpenAI-compatible endpoint that answers
 * "Fixture reply: <last user text>" after a short delay, and drops a request the client aborts. `home` is both the
 * Octocode home and the agent directory of the run and receives `models.json` (the provider). `userHome` is the
 * run's HOME; its `.claude/settings.json` gets a `SessionStart` hook that appends `{"kind":"worker","pid":<pid>}` to
 * `pidJournal` for the process that runs each session.
 */
export async function startFixtureModel({ home, userHome, pidJournal }) {
	const server = createServer((request, response) => {
		const body = [];
		request.on("data", (part) => body.push(part));
		request.on("end", () => {
			let parsed;
			try {
				parsed = JSON.parse(Buffer.concat(body).toString() || "null");
			} catch {
				parsed = null;
			}
			const timer = setTimeout(() => {
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				response.write(chunk({ role: "assistant" }, null));
				response.write(chunk({ content: `Fixture reply: ${lastUserText(parsed)}` }, null));
				response.write(chunk({}, "stop"));
				response.end("data: [DONE]\n\n");
			}, REPLY_DELAY_MS);
			response.on("close", () => clearTimeout(timer));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	mkdirSync(home, { recursive: true });
	writeFileSync(
		join(home, "models.json"),
		JSON.stringify({
			providers: {
				[FIXTURE_PROVIDER]: {
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					api: "openai-completions",
					apiKey: "fixture-key",
					models: [
						{
							id: FIXTURE_MODEL,
							name: "ACP compatibility fixture",
							reasoning: false,
							input: ["text", "image"],
							contextWindow: 128_000,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	mkdirSync(join(userHome, ".claude"), { recursive: true });
	writeFileSync(
		join(userHome, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				SessionStart: [
					{
						hooks: [{ type: "command", command: `echo '{"kind":"worker","pid":'$PPID'}' >> "${pidJournal}"` }],
					},
				],
			},
		}),
	);
	return {
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
