import fs from "node:fs";
import { approveFixtureMcp } from "./guard-helpers.ts";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { fixture } from "./permission-session-fixture.ts";

afterEach(() => vi.unstubAllEnvs());

/** A reader server that returns the file's text as one JSON block, as the generic reader contract credits it. */
const READER = `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'reader',version:'1'}}:m.method==='tools/list'?{tools:[{name:'read_file',inputSchema:{type:'object',properties:{path:{type:'string'}}}}]}:m.method==='tools/call'?{content:[{type:'text',text:JSON.stringify({path:m.params.arguments.path,raw:fs.readFileSync(m.params.arguments.path,'utf8')})}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;

it("credits a read that follows a `file` edit of the same file in one batch with the post-edit content", async () => {
	const f = await fixture("claude", { mode: "full", nestedMcp: true });
	try {
		const server = path.join(f.root, "reader.cjs");
		fs.writeFileSync(server, READER);
		fs.writeFileSync(
			path.join(f.root, "agent", "mcp.json"),
			JSON.stringify({
				mcpServers: { reader: { command: process.execPath, args: [server], roles: { reader: ["read_file"] } } },
			}),
		);
		approveFixtureMcp(f.cwd, path.join(f.root, "agent"));
		await f.restart();
		await f.session.prompt("/mcp tools reader");
		await vi.waitFor(
			() => expect(f.session.getAllTools().some((tool) => tool.name === "mcp__reader__read_file")).toBe(true),
			{ timeout: 5000 },
		);
		const file = path.join(fs.realpathSync(f.cwd), "notes.txt");
		fs.writeFileSync(file, "alpha\nbeta\n");
		// The file guard wants the file read before it is rewritten.
		f.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__reader__read_file", { path: file })], { stopReason: "toolUse" }),
			fauxAssistantMessage("READ"),
		]);
		await f.session.prompt("Read first.");
		f.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("file", {
						reason: "Rewrite the notes",
						queries: [{ type: "write", path: file, content: "gamma\ndelta\n", reason: "Rewrite the notes" }],
					}),
					fauxToolCall("mcp__reader__read_file", { path: file }, { id: "read-after-edit" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("DONE"),
		]);
		await f.session.prompt("Edit then read.");
		expect(fs.readFileSync(file, "utf8")).toBe("gamma\ndelta\n");
		const result = f.session.messages.find((m) => m.role === "toolResult" && m.toolCallId === "read-after-edit");
		expect(JSON.stringify(result)).toContain("gamma");
		expect((result as { details?: { localReads?: unknown } }).details?.localReads).toEqual([
			{ file, sha256: sha256(Buffer.from("gamma\ndelta\n")), size: 12, whole: true },
		]);
	} finally {
		await f.close();
	}
});
