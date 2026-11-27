import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { script } from "../src/gateway.ts";
import { chat, gateway } from "./helpers.ts";

/* Scripted faults (stop reasons, malformed arguments, dropped connections), harness-reported tool errors, the
 * non-streaming Responses reply and cassette keys that cover sampling settings. */

const post = (url: string, path: string, body: unknown): Promise<Response> =>
	fetch(`${url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

const hi = [{ role: "user", content: "hi" }];

describe("scripted stop reasons", () => {
	it("max_tokens and refusal reach each wire's own stop field", async () => {
		const gw = await gateway({
			responder: script([
				{ text: "cut", stop: "max_tokens" },
				{ text: "no", stop: "refusal" },
			]),
		});
		const chat1 = (await (await chat(gw.url, { model: "m", messages: hi })).json()) as {
			choices: { finish_reason: string }[];
		};
		expect(chat1.choices[0].finish_reason).toBe("length");
		const anth = (await (await post(gw.url, "/v1/messages", { model: "m", max_tokens: 9, messages: hi })).json()) as {
			stop_reason: string;
		};
		expect(anth.stop_reason).toBe("refusal");
		const gw2 = await gateway({ responder: script([{ text: "cut", stop: "max_tokens" }]) });
		const resp = (await (await post(gw2.url, "/v1/responses", { model: "m", input: "hi" })).json()) as {
			status: string;
			incomplete_details: { reason: string };
		};
		expect(resp).toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
		const gem = (await (
			await post(gw2.url, "/v1beta/models/g:generateContent", { contents: [{ role: "user", parts: [{ text: "hi" }] }] })
		).json()) as {
			candidates: { finishReason: string }[];
		};
		expect(gem.candidates[0].finishReason).toBe("MAX_TOKENS");
	});
});

describe("malformed tool arguments", () => {
	it("rawArgs reaches the client verbatim and stays visible on the trace", async () => {
		const gw = await gateway({ responder: script([{ toolCalls: [{ name: "search", rawArgs: '{"query": "ca' }] }]) });
		const body = (await (await chat(gw.url, { model: "m", messages: hi })).json()) as {
			choices: { message: { tool_calls: { function: { arguments: string } }[] } }[];
		};
		expect(body.choices[0].message.tool_calls[0].function.arguments).toBe('{"query": "ca');
		expect(gw.trace.of("model_tool_call")[0].args).toBe('{"query": "ca');
		const sse = await (
			await post(gw.url, "/v1/messages", { model: "m", max_tokens: 9, stream: true, messages: hi })
		).text();
		const parts = [...sse.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
		expect(parts).toBe('{"query": "ca');
	});
});

describe("dropped connections", () => {
	it("before-reply closes with no response; mid-stream cuts the body", async () => {
		const gw = await gateway({ responder: script([{ disconnect: "before-reply" }, { disconnect: "mid-stream" }]) });
		await expect(chat(gw.url, { model: "m", messages: hi })).rejects.toThrow();
		const r = await chat(gw.url, {
			model: "m",
			stream: true,
			messages: [...hi, { role: "assistant", content: "" }, ...hi],
		});
		await expect(r.text()).rejects.toThrow();
		expect(gw.trace.requests).toHaveLength(2);
		expect(gw.trace.of("answer")).toHaveLength(0);
		expect(gw.errors).toEqual([]);
	});
});

describe("tool errors the harness reports", () => {
	const request = (isError: boolean) => ({
		model: "m",
		max_tokens: 9,
		messages: [
			{ role: "user", content: "run it" },
			{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "make" } }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "make: not found", is_error: isError }],
			},
		],
	});

	it("an Anthropic is_error result of a built-in tool is a tool_error once, so toReflect sees it", async () => {
		const gw = await gateway({ responder: script([{ text: "giving up" }]) });
		await post(gw.url, "/v1/messages", request(true));
		await post(gw.url, "/v1/messages", {
			...request(true),
			messages: [
				...request(true).messages,
				{ role: "assistant", content: "giving up" },
				{ role: "user", content: "again?" },
			],
		});
		const errors = gw.trace.of("tool_error");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			name: "Bash",
			args: { command: "make" },
			data: { reason: "harness", message: "make: not found" },
		});
		expect(() => expect(gw.trace).toReflect({ after: "error" })).toThrow(/answered .* right after tool_error/);
	});

	it("a successful result is no error", async () => {
		const gw = await gateway({ responder: script([{ text: "ok" }]) });
		await post(gw.url, "/v1/messages", request(false));
		expect(gw.trace.of("tool_error")).toHaveLength(0);
	});
});

describe("Responses without streaming", () => {
	it("answers one JSON response object", async () => {
		const gw = await gateway({ responder: script([{ toolCalls: [{ name: "read", args: { p: 1 } }] }]) });
		const r = await post(gw.url, "/v1/responses", { model: "m", input: "hi", stream: false });
		expect(r.headers.get("content-type")).toBe("application/json");
		const body = (await r.json()) as { object: string; output: { type: string; name?: string }[] };
		expect(body.object).toBe("response");
		expect(body.output[0]).toMatchObject({ type: "function_call", name: "read" });
	});
});

describe("cassette keys", () => {
	const closers: (() => void)[] = [];
	afterEach(() => {
		for (const c of closers.splice(0)) c();
	});

	it("a change of tool_choice or temperature misses instead of replaying the old reply", async () => {
		let calls = 0;
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				calls++;
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						choices: [{ message: { content: `reply ${calls}` } }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					}),
				);
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		closers.push(() => server.close());
		const dir = mkdtempSync(join(tmpdir(), "testkit-keys-"));
		closers.push(() => rmSync(dir, { recursive: true, force: true }));
		const forward = {
			baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			api: "openai" as const,
			key: "k",
		};
		const cassette = { mode: "auto" as const, file: join(dir, "c.json") };
		const ask = async (extra: Record<string, unknown>): Promise<string> => {
			const gw = await gateway({ forward, cassette });
			const body = (await (await chat(gw.url, { model: "m", messages: hi, ...extra })).json()) as {
				choices: { message: { content: string } }[];
			};
			return body.choices[0].message.content;
		};
		expect(await ask({ temperature: 0 })).toBe("reply 1");
		expect(await ask({ temperature: 0 })).toBe("reply 1");
		expect(await ask({ temperature: 1 })).toBe("reply 2");
		expect(await ask({ temperature: 0, tool_choice: "required" })).toBe("reply 3");
		// Volatile ids stay out of the key.
		expect(await ask({ temperature: 0, user: "someone-else", metadata: { run: "x" } })).toBe("reply 1");
		expect(calls).toBe(3);
	});
});
