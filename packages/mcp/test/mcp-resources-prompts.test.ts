import fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import { commandWords } from "../src/catalog-command.ts";
import { promptArguments } from "../src/catalog-requests.ts";
import type { McpServerEntry } from "../src/config.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

/**
 * MCP resources and prompts through the public entry points: the model's `mcp` tool (`resources`, `read`) and the
 * user's `/mcp resources|prompts|prompt`, against real stdio fixture servers.
 */
const fixtures = join(import.meta.dirname, "client/fixtures");
const hosts: ReturnType<typeof mcpHost>[] = [];
afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
	vi.unstubAllEnvs();
});

function host(script: string, log?: string) {
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", tmp());
	const entry: McpServerEntry = {
		name: "cat",
		source: "test",
		config: {
			command: process.execPath,
			args: [join(fixtures, script)],
			exposure: "direct",
			...(log ? { env: { MCP_FIXTURE_LOG: log } } : {}),
		},
	};
	const h = mcpHost({ servers: [entry] });
	const notes: string[] = [];
	vi.spyOn(h.ctx.ui, "notify").mockImplementation((text: string) => void notes.push(text));
	const sent = vi.fn();
	(h.api.session as { sendUserMessage?: (text: string) => void }).sendUserMessage = sent;
	hosts.push(h);
	const slash = async (args: string) => {
		await h.commands.get("mcp").handler(args, h.ctx);
		return notes.at(-1);
	};
	return { h, notes, sent, slash };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => part.text ?? "").join("");

describe("MCP resources through the mcp tool", () => {
	it("lists resources and templates, then reads one verbatim", async () => {
		const { h } = host("catalog-server.mjs");
		await h.start();
		await h.state.pending;
		const listed = text(await h.call("mcp", { intent: "resources", server: "cat" }));
		expect(listed).toBe(
			[
				"- fixture://guide guide: How to use the fixture (text/markdown)",
				"- fixture://logo logo (application/octet-stream)",
				"- template fixture://file/{path} file",
			].join("\n"),
		);
		const read = await h.call("mcp", { intent: "read", server: "cat", uri: "fixture://guide" });
		expect(text(read)).toBe("[resource fixture://guide (text/markdown)]\nRead me first.\nSecond line.");
		expect(read.isError).toBeUndefined();
		const blob = await h.call("mcp", { intent: "read", server: "cat", uri: "fixture://logo" });
		expect(text(blob)).toBe("[resource fixture://logo (application/octet-stream, 3 bytes of binary data, not shown)]");
	});

	it("surfaces the server's error for an unknown URI and asks for a missing one", async () => {
		const { h } = host("catalog-server.mjs");
		await h.start();
		await h.state.pending;
		await expect(h.call("mcp", { intent: "read", server: "cat", uri: "fixture://nope" })).rejects.toThrow(
			"Resource not found: fixture://nope",
		);
		await expect(h.call("mcp", { intent: "read", server: "cat" })).rejects.toThrow("uri field");
	});

	it("answers from the capability for a server without resources, sending no resource request", async () => {
		const { h } = host("stdio-server.mjs");
		await h.start();
		await h.state.pending;
		expect(text(await h.call("mcp", { intent: "resources", server: "cat" }))).toBe(
			'MCP server "cat" offers no resources.',
		);
		await expect(h.call("mcp", { intent: "read", server: "cat", uri: "x://y" })).rejects.toThrow("offers no resources");
	});
});

describe("/mcp resources, prompts and prompt", () => {
	it("lists resources and prompts with their arguments", async () => {
		const { h, slash } = host("catalog-server.mjs");
		await h.start();
		expect(await slash("resources cat")).toContain("- fixture://guide guide: How to use the fixture");
		expect(await slash("prompts cat")).toBe("- review <path> [focus]: Review a file");
	});

	it("maps positional and key=value arguments and sends the prompt as the user's message", async () => {
		const log = join(tmp(), "requests.log");
		const { h, sent, slash } = host("catalog-server.mjs", log);
		await h.start();
		await slash('prompt cat review "src/my app.ts" focus=bugs');
		expect(sent).toHaveBeenCalledWith("Review src/my app.ts\n\nFocus: bugs");
		await slash("prompt cat review focus=speed lib.ts");
		expect(sent).toHaveBeenLastCalledWith("Review lib.ts\n\nFocus: speed");
		expect(fs.readFileSync(log, "utf8")).toContain("prompts/get");
	});

	it("reports a missing required argument, an unknown prompt and bad usage without sending", async () => {
		const { h, sent, slash } = host("catalog-server.mjs");
		await h.start();
		expect(await slash("prompt cat review")).toBe("Missing required argument: path.");
		expect(await slash("prompt cat nope")).toBe('No prompt "nope" on MCP server "cat".');
		expect(await slash("prompt cat")).toContain("Usage:");
		expect(sent).not.toHaveBeenCalled();
	});
});

describe("promptArguments", () => {
	const declared = [{ name: "a", required: true }, { name: "b" }];
	it("fills free declared arguments in order and rejects extras", () => {
		expect({ ...promptArguments(declared, ["b=2", "one"]) }).toEqual({ a: "one", b: "2" });
		expect(() => promptArguments(declared, ["1", "2", "3"])).toThrow("Too many arguments");
		expect(Object.getPrototypeOf(promptArguments(declared, ["__proto__=x", "a=1"]))).toBeNull();
	});
});

describe("commandWords", () => {
	it("keeps a quoted value with spaces in one argument, and a quoted empty value as an empty argument", () => {
		expect(commandWords(`prompt srv name key="a b" other='c d' plain`)).toEqual([
			"prompt",
			"srv",
			"name",
			"key=a b",
			"other=c d",
			"plain",
		]);
		expect(commandWords(`"two words" ""  x=""`)).toEqual(["two words", "", "x="]);
		const declared = [{ name: "key", required: true }];
		expect({ ...promptArguments(declared, commandWords(`key="a b"`)) }).toEqual({ key: "a b" });
		expect({ ...promptArguments([{ name: "a" }], commandWords(`""`)) }).toEqual({ a: "" });
	});
});
