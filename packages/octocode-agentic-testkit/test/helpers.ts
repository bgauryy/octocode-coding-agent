import { afterEach } from "vitest";
import { startGateway, type Gateway, type GatewayOptions } from "../src/gateway.ts";
import { mockMcp, type MockMcp, type ToolDef } from "../src/mcp.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((c) => c()));
});

export async function gateway(opts: GatewayOptions = {}): Promise<Gateway> {
	const g = await startGateway(opts);
	closers.push(() => g.close());
	return g;
}

export function mcp(gw: Gateway, name: string, tools: ToolDef[]): MockMcp {
	const m = mockMcp({ name, tools, trace: gw.trace });
	closers.push(() => m.close());
	return m;
}

export const searchTool: ToolDef = {
	name: "search",
	description: "Search the docs",
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" }, limit: { type: "integer" } },
		required: ["query"],
	},
};

export async function chat(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${url}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}
