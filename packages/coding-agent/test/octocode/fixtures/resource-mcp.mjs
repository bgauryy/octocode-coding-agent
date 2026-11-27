import readline from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const toolsEnabled = process.argv[2] !== "resources-only";
let failList = false;
const uri = "docs://intro";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	let result;
	switch (message.method) {
		case "initialize":
			result = {
				protocolVersion: message.params.protocolVersion,
				capabilities: { resources: {}, ...(toolsEnabled ? { tools: { listChanged: true } } : {}) },
				serverInfo: { name: "resource-fixture", version: "1" },
			};
			break;
		case "tools/list":
			if (failList) return send({ id: message.id, error: { code: -32603, message: "catalog unavailable" } });
			result = { tools: [{ name: "link", description: "Get a resource link", inputSchema: { type: "object" } }] };
			break;
		case "resources/list":
			result = { resources: [{ uri, name: "intro" }] };
			break;
		case "resources/read":
			if (message.params.uri !== uri) return send({ id: message.id, error: { code: -32002, message: "Unknown URI" } });
			result = { contents: [{ uri, text: "Resource evidence" }] };
			break;
		case "tools/call":
			if (message.params.arguments?.failList) {
				failList = true;
				send({ method: "notifications/tools/list_changed" });
			}
   if (message.params.arguments?.slow) {
    setTimeout(()=>send({id:message.id,result:{content:[{type:"text",text:"TOOL_EVIDENCE"}]}}),250);
    return;
   }
   result = { content: [{ type: "resource_link", uri, name: "intro" }] };
			break;
		default:
			return send({ id: message.id, error: { code: -32601, message: "Unknown method" } });
	}
	send({ id: message.id, result });
});
