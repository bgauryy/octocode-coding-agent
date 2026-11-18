/** Renders the `--mode json` events of one session as plain text a grader can read: turns, tool calls, tool results. */

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s);

interface Block {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	input?: unknown;
}

function blocksOf(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Block[]) : [];
}

export function transcriptOf(events: Record<string, unknown>[]): string {
	const lines: string[] = [];
	for (const e of events) {
		if (e.type !== "message_end") continue;
		const m = e.message as { role?: string; content?: unknown; toolName?: string; isError?: boolean } | undefined;
		if (!m) continue;
		for (const b of blocksOf(m.content)) {
			if (m.role === "user" && b.text) lines.push(`USER: ${clip(b.text, 1500)}`);
			else if (m.role === "assistant" && b.type === "text" && b.text) lines.push(`ASSISTANT: ${clip(b.text, 2000)}`);
			else if (m.role === "assistant" && (b.type === "toolCall" || b.type === "tool_use"))
				lines.push(`ASSISTANT TOOL CALL: ${b.name} ${clip(JSON.stringify(b.arguments ?? b.input ?? {}), 600)}`);
			else if (m.role === "toolResult" && b.text)
				lines.push(`TOOL RESULT (${m.toolName ?? "?"}${m.isError ? ", error" : ""}): ${clip(b.text, 800)}`);
		}
	}
	return lines.join("\n");
}
