import { beforeAll, expect, it } from "vitest";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

it("draws directory, branch and session labels without terminal controls or newlines", () => {
	const hostile = (value: string) => `${value}\u001b]0;injected\u0007\nnext\u001b[2J`;
	const session = {
		state: { model: undefined },
		sessionManager: {
			getEntryCount: () => 0,
			getSessionId: () => "test",
			getLeafId: () => null,
			getEntries: () => [],
			getBranch: () => [],
			getCwd: () => hostile("/tmp/project"),
			getSessionName: () => hostile("session"),
		},
		getContextUsage: () => undefined,
		modelRuntime: {},
	};
	const data = {
		getGitBranch: () => hostile("main"),
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 0,
		onBranchChange: () => () => {},
	};
	const line = new FooterComponent(session as never, data).render(200)[0];
	expect(line).not.toContain("\u001b]");
	expect(line).not.toContain("\u001b[2J");
	expect(stripAnsi(line)).toBe("/tmp/project next (main next) · session next");
});
