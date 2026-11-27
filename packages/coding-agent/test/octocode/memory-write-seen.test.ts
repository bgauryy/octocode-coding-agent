import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import { memoryStore } from "../../src/octocode/memory/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";

let root: string;
let cwd: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-memory-write-seen-"));
	cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", "");
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

const TITLE = "Staging migrations only";

/**
 * The memory feature on a real in-memory session; `tool` runs the `memory` tool and records its result as the agent loop
 * does. Without the MEMORY.md files, so recall alone decides what is sent (a saved line in the prompt's file section is
 * left out of recall: memory-file-session.test.ts).
 */
function harness() {
	const session = SessionManager.inMemory(cwd);
	const fake = fakeHost({ memory: { file: false } });
	registerMemory(fake.api, {
		commands: new Subcommands(),
		isSubagent: false,
		permission: fakePermission("workspace", { api: fake.api }),
	});
	const ctx = (selects: string[] = []) =>
		Object.assign(fakeCtx({ cwd, hasUI: true, ui: { selects, inputs: [] } }), {
			isProjectTrusted: () => true,
			sessionManager: session,
		});
	let call = 0;
	const tool = async (params: Record<string, unknown>, selects: string[] = []) => {
		const toolCallId = `call-${++call}`;
		const result = await fake.tools.get("memory").execute(toolCallId, params, undefined, undefined, ctx(selects));
		session.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "memory",
			content: result.content,
			details: result.details,
			isError: false,
			timestamp: Date.now(),
		} as never);
		return result as { content: Array<{ text: string }>; details: unknown };
	};
	/** The next prompt's injection, committed to the session as the host commits it. */
	const prompt = async (text: string) => {
		const out = (await fake.fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: text },
			ctx(),
		)) as { message: { customType: string; content: string; display: boolean; details: unknown } } | undefined;
		if (out) session.appendCustomMessageEntry(out.message.customType, out.message.content, false, out.message.details);
		session.appendMessage({ role: "user", content: text, timestamp: Date.now() } as never);
		return out?.message.content ?? "";
	};
	return { session, tool, prompt };
}

describe("a durable memory the memory tool saved this session", () => {
	it("is not injected again on the next prompt, pinned or recalled by words", async () => {
		const h = harness();
		const saved = await h.tool({ op: "set", title: TITLE, body: "Never run them against production", pinned: true }, [
			"Allow once",
		]);
		expect(saved.content[0].text).toMatch(/^Saved M\d+/);
		expect(await h.prompt("How do I run the staging migrations?")).not.toContain(TITLE);
	});

	it("is injected again once edited elsewhere, or after a compaction summarized the save away", async () => {
		const h = harness();
		await h.tool({ op: "set", title: TITLE, pinned: true }, ["Allow once"]);
		const store = memoryStore(cwd);
		const [memory] = store.list("all", 10);
		store.set({ id: memory.id, body: "Edited by the user", author: "user" }, Date.now() + 1000);
		expect(await h.prompt("next")).toContain(TITLE);

		const after = harness();
		await after.tool({ op: "set", title: "Use tabs", pinned: true }, ["Allow once"]);
		const kept = after.session.appendMessage({ role: "user", content: "later", timestamp: Date.now() } as never);
		after.session.appendCompaction("Earlier work", kept, 100);
		expect(await after.prompt("next")).toContain("Use tabs");
	});

	it("still lets a read-only result (get, search) leave the memory to the injection", async () => {
		const h = harness();
		memoryStore(cwd).set({ title: TITLE, pinned: true, author: "user" });
		await h.tool({ op: "search", query: "staging" });
		expect(await h.prompt("next")).toContain(TITLE);
	});
});
