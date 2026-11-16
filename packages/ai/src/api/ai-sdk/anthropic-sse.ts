import { parseJsonWithRepair } from "../../utils/json-parse.ts";

export function repairAnthropicSse(response: Response): Response {
	if (!response.ok || !response.body) return response;
	let pending = "";
	let stopped = false;
	let outputTokens = 0;
	const line = (value: string): string => {
		if (!value.startsWith("data:")) return value;
		const end = value.endsWith("\r\n") ? "\r\n" : value.endsWith("\n") ? "\n" : "";
		const prefix = value.startsWith("data: ") ? "data: " : "data:";
		const data = value.slice(prefix.length, value.length - end.length);
		let parsed: Record<string, unknown>;
		let repaired = false;
		try {
			parsed = JSON.parse(data);
		} catch {
			parsed = parseJsonWithRepair(data);
			repaired = true;
		}
		if (parsed.type === "message_stop") stopped = true;
		const usage = (
			parsed.type === "message_start" ? (parsed.message as { usage?: { output_tokens?: number } })?.usage : parsed.usage
		) as { output_tokens?: number } | undefined;
		if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
		if (parsed.type === "message_delta" && !("usage" in parsed)) {
			parsed.usage = { output_tokens: outputTokens };
			repaired = true;
		}
		return repaired ? prefix + JSON.stringify(parsed) + end : value;
	};
	const body = response.body
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(
			new TransformStream<string, string>({
				transform(chunk, controller) {
					pending += chunk;
					let end: number;
					while ((end = pending.indexOf("\n")) >= 0) {
						const next = pending.slice(0, end + 1);
						controller.enqueue(line(next));
						pending = pending.slice(end + 1);
						if (stopped && !next.trim()) {
							pending = "";
							controller.terminate();
							return;
						}
					}
					if (pending.length > 4 * 1024 * 1024) throw new Error("Anthropic SSE data line exceeds 4 MiB");
				},
				flush(controller) {
					if (pending) controller.enqueue(line(pending));
				},
			}),
		)
		.pipeThrough(new TextEncoderStream());
	return new Response(body, response);
}
