import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBus } from "@octocodeai/octocode-agent-core";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureError } from "../src/core/features/types.ts";
import { listenerErrorReporter } from "../src/core/listener-diagnostics.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestSession } from "./helpers/session.ts";
import { testFeatures } from "./helpers/features.ts";

/**
 * The agent library contains a listener or event-bus handler that throws and reports it through a reporter the host
 * passes. Octocode's reporter sends the line to the session's diagnostics (the extension error channel every mode
 * binds), not raw stderr, which the terminal UI would draw over.
 */
const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function sessionWithBus() {
	const root = join(tmpdir(), `octocode-listener-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	dirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const settingsManager = SettingsManager.inMemory({});
	let bus: EventBus | undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		features: testFeatures([
			(api) => {
				bus = api.channels;
			},
		]),
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd: root,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(root),
		model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
	});
	const errors: FeatureError[] = [];
	session.featureHost.onError((error) => errors.push(error));
	if (!bus) throw new Error("the extension did not load");
	return { session, bus, errors };
}

describe("listener failures reach the session's diagnostics", () => {
	it("routes an event-bus handler that throws to the extension error channel, not stderr", async () => {
		const { session, bus, errors } = await sessionWithBus();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			bus.on("ping", () => {
				throw new Error("boom");
			});
			bus.emit("ping", {});
			await vi.waitFor(() => expect(errors).toHaveLength(1));
			expect(errors[0]).toMatchObject({ source: "event bus", event: "listener_error" });
			expect(errors[0].error).toBe("Event handler error (ping): Error: boom");
			expect(errors[0].stack).toContain("boom");
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			session.dispose();
		}
	});

	it("gives the agent a reporter that routes its listener failures the same way", async () => {
		const { session, errors } = await sessionWithBus();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			session.agent.onListenerError?.("Tool update listener error (bash): Error: late", new Error("late"));
			expect(errors).toEqual([
				expect.objectContaining({ source: "agent", error: "Tool update listener error (bash): Error: late" }),
			]);
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			session.dispose();
		}
	});

	it("falls back to one stderr line before a session has a runner", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		listenerErrorReporter(() => undefined, "agent")("Event handler error (x): oops", "oops");
		expect(stderr).toHaveBeenCalledWith("Event handler error (x): oops\n");
	});

	it("falls back to stderr when nothing listens to the runner's errors (an SDK session), so no failure is dropped", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const emitError = vi.fn();
		listenerErrorReporter(() => ({ emitError, hasErrorListeners: () => false }), "agent")(
			"Event handler error (y): no one",
			"no one",
		);
		expect(emitError).not.toHaveBeenCalled();
		expect(stderr).toHaveBeenCalledWith("Event handler error (y): no one\n");
	});
});
