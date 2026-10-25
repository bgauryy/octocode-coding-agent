import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@octocodeai/octocode-ai";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";

/** Offline model for exercising the real CLI with independent ACP clients. */
export default function register(api: ExtensionAPI): void {
	const pidJournal = process.env.OCTOCODE_ACP_FIXTURE_PIDS;
	if (pidJournal) appendFileSync(pidJournal, `${JSON.stringify({ kind: "worker", pid: process.pid })}\n`, { mode: 0o600 });
	api.registerProvider("acp-compatibility-fixture", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "fixture-key",
		models: [{
			id: "fixture", name: "ACP compatibility fixture", reasoning: false, input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
		}],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.findLast((message) => message.role === "user");
			const text = typeof last?.content === "string" ? last.content :
				last?.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
			const message: AssistantMessage = {
				role: "assistant", content: [{ type: "text", text: `Fixture reply: ${text}` }],
				api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", finish);
				if (options?.signal?.aborted) {
					stream.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted" } });
				} else stream.push({ type: "done", reason: "stop", message });
			};
			const timer = setTimeout(finish, 1500);
			options?.signal?.addEventListener("abort", finish, { once: true });
			if (options?.signal?.aborted) finish();
			return stream;
		},
	});
}
