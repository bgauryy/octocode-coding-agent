import { Container } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntimeDiagnostic } from "../../../src/core/agent-session-services.ts";
import * as startup from "../../../src/modes/interactive/interactive-mode/startup.ts";
import { initTheme } from "../../../src/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness } from "../harness.ts";
import { createFakeHost } from "../../interactive-mode-host.ts";

function render(container: Container): string {
	return stripAnsi(container.children.flatMap((child) => child.render(120)).join("\n"));
}

describe("invalid settings warning", () => {
	beforeAll(() => initTheme("dark"));

	it("renders startup diagnostics inside the transcript", async () => {
		const harness = await createHarness();
		const previousOffline = process.env.OCTOCODE_OFFLINE;
		process.env.OCTOCODE_OFFLINE = "1";
		try {
			const chatContainer = new Container();
			const startupDiagnostics: AgentSessionRuntimeDiagnostic[] = [
				{
					type: "warning",
					message: "Invalid settings file /tmp/settings.json: malformed JSON",
				},
			];
			const context = {
				init: vi.fn(async () => {}),
				options: { startupDiagnostics },
				chatContainer,
				ui: { requestRender: vi.fn() },
				version: "test",
				session: harness.session,
				checkForPackageUpdates: vi.fn().mockResolvedValue([]),
				checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				getUserInput: vi.fn(() => new Promise<string>(() => {})),
			};
			void startup.run(createFakeHost(context));

			await vi.waitFor(() => {
				expect(render(chatContainer)).toContain("⚠ ▲ Invalid settings file /tmp/settings.json: malformed JSON");
			});
		} finally {
			if (previousOffline === undefined) delete process.env.OCTOCODE_OFFLINE;
			else process.env.OCTOCODE_OFFLINE = previousOffline;
			harness.cleanup();
		}
	});
});
