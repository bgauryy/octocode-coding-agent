import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSession } from "./helpers/session.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("session session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `octocode-session-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses the checkout for the default transcript even with a separate configuration directory", async () => {
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createTestSession({
			cwd,
			agentDir,
			model: model,
		});

		const expectedSessionDir = join(realpathSync(cwd), ".octocode", "code", "sessions");
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createTestSession({
			cwd,
			agentDir,
			model: model,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createTestSession({
			agentDir,
			model: model,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`<cwd>\n${sessionCwd}\n</cwd>`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		const [header, ...body] = output.trim().split("\n");
		expect(header).toMatch(/^\[exit 0 · /);
		expect(realpathSync(body.join("\n"))).toBe(realpathSync(sessionCwd));

		session.dispose();
	});

	it("exposes current session state to the built-in bash tool", async () => {
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createTestSession({
			cwd,
			agentDir,
			model: model,
			thinkingLevel: "high",
		});
		expect(session.sessionFile).toBeTruthy();
		expect(session.systemPrompt).not.toContain("OCTOCODE_* environment variables");

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `printf '%s\\n' "$OCTOCODE_SESSION_ID" "$OCTOCODE_SESSION_FILE" "$OCTOCODE_PROVIDER" "$OCTOCODE_MODEL" "$OCTOCODE_REASONING_LEVEL"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		const [header, ...body] = output.trim().split("\n");
		expect(header).toMatch(/^\[exit 0 · .* · 5 lines · /);
		expect(body).toEqual([session.sessionId, session.sessionFile, model.provider, model.id, session.thinkingLevel]);

		session.dispose();
	});
});
