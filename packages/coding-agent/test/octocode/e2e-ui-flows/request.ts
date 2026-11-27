/** User message contents in the order this scripted provider received them. */
export const userTexts = (request: string): string[] =>
	(JSON.parse(request) as Array<{ role: string; content: Array<{ text?: string }> | string }>)
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("")));

export const terminalInput = (text: string): string => `[src terminal:terminal ✓proven via terminal] t4\n${text}`;
