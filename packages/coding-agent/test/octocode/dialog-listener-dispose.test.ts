import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { withDialog } from "../../src/octocode/shared/locks.ts";
import { registerActivity } from "../../src/octocode/ui/activity.ts";
import { createTestSession } from "../helpers/session.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});

/** A real session whose extension is `registerActivity`, the subscriber to the process-wide dialog queue. */
async function sessionWithActivity(onChange: (line: string | undefined) => void) {
	const cwd = tmp("octocode-dialog-dispose-");
	const agentDir = tmp("octocode-dialog-dispose-agent-");
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const factory: FeatureRegister = (api) => {
		registerActivity(api, { onChange, workingLine: true });
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		nativeFeatures: nativeFeatureSet(),
		features: testFeatures([{ name: "activity", factory }]),
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	sessions.push(session);
	await session.bindFeatures({
		uiContext: fakeCtx({ cwd }).ui,
		mode: "tui",
		shutdownHandler: () => undefined,
	} as never);
	return session;
}

describe("a disposed session's dialog-queue listener", () => {
	it("does not break a dialog in the next session after a bare dispose()", async () => {
		const a = await sessionWithActivity(vi.fn());
		await sessionWithActivity(vi.fn());

		a.dispose(); // no session_shutdown, as an embedder or a test would

		const first = withDialog(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return "answered";
		});
		const second = withDialog(async () => "queued");
		await expect(first).resolves.toBe("answered");
		await expect(second).resolves.toBe("queued");
	});
});
