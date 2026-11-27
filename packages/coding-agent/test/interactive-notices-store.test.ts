import { Container } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { suggestBugReport } from "../src/modes/interactive/interactive-mode/crash-reporting.ts";
import { showStartupNoticesIfNeeded } from "../src/modes/interactive/interactive-mode/startup-checks.ts";
import { isNoticeShown } from "../src/modes/interactive/state/notices-slice.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const text = (container: Container) => stripAnsi(container.render(100).join("\n"));

describe("notices slice", () => {
	beforeAll(() => initTheme("dark"));

	it("claims a notice once and publishes nothing for a repeat", () => {
		const store = createUiStore();
		const listener = vi.fn();
		store.subscribe(listener);

		expect(store.getState().claimNotice("installChange")).toBe(true);
		expect(store.getState().claimNotice("installChange")).toBe(false);
		expect(isNoticeShown(store.getState(), "installChange")).toBe(true);
		expect(isNoticeShown(store.getState(), "startup")).toBe(false);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("says the /bug hint once per host", () => {
		const host = createFakeHost({
			uiStore: createUiStore(),
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
		});

		suggestBugReport(host);
		suggestBugReport(host);

		expect(host.chatContainer.children).toHaveLength(1);
		expect(text(host.chatContainer)).toContain("/bug sends a report");
	});

	it("shows the new changelog entries once, and never after a start without any", () => {
		const fixture = (changelog: string | undefined) => {
			const uiStore = createUiStore();
			uiStore.getState().setChangelog(changelog);
			return createFakeHost({
				uiStore,
				chatContainer: new Container(),
				settingsManager: { getCollapseChangelog: () => true },
				version: "0.0.0",
			});
		};
		const host = fixture("## [1.2.3]\n- Fixed a thing");

		showStartupNoticesIfNeeded(host);
		const shown = host.chatContainer.children.length;
		showStartupNoticesIfNeeded(host);

		expect(text(host.chatContainer)).toContain("Updated to v1.2.3");
		expect(host.chatContainer.children).toHaveLength(shown);

		const quiet = fixture(undefined);
		showStartupNoticesIfNeeded(quiet);
		quiet.uiStore.getState().setChangelog("## [1.2.4]\n- Later");
		showStartupNoticesIfNeeded(quiet);
		expect(quiet.chatContainer.children).toHaveLength(0);
	});
});
