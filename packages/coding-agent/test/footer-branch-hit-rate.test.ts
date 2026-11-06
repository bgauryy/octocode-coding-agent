// B123 L6: the footer's CH figure is the cache hit rate of the latest reply on the current branch. After `/tree` back to
// an earlier branch it must not show the reply another branch wrote last.
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const reply = (id: string, parentId: string | null, cacheRead: number, prompt = 100) => ({
	type: "message",
	id,
	parentId,
	message: {
		role: "assistant",
		usage: { input: prompt - cacheRead, output: prompt ? 1 : 0, cacheRead, cacheWrite: 0, cost: { total: 0 } },
	},
});

function sessionAt(leafId: string): AgentSession {
	// File order: a root reply, then a reply on branch A, then a reply on branch B written last.
	// Then an aborted reply with no usage after A, and a reply that read all but 4 of 10,000 prompt tokens.
	const entries = [
		reply("root", null, 25),
		reply("a", "root", 90),
		reply("b", "root", 50),
		reply("aborted", "a", 0, 0),
		reply("nearly", "root", 9996, 10_000),
	];
	const branch = (from: string) => {
		const path: typeof entries = [];
		for (
			let next = entries.find((entry) => entry.id === from);
			next;
			next = entries.find((e) => e.id === next?.parentId)
		)
			path.unshift(next);
		return path;
	};
	return {
		state: { model: { id: "m", provider: "p", contextWindow: 200_000, reasoning: false }, thinkingLevel: "off" },
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => branch(leafId),
			getEntryCount: () => entries.length,
			getSessionId: () => "s",
			getLeafId: () => leafId,
			getSessionName: () => undefined,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 1 }),
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
}

const data = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map<string, string>(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
	getState: () => ({ branch: "main", providerCount: 1, statuses: new Map() }),
	subscribe: () => () => {},
};

describe("footer cache hit rate", () => {
	beforeAll(() => initTheme("dark"));
	it.each([
		["a", "CH90.0%"],
		["b", "CH50.0%"],
		// A reply without usage keeps the last known rate instead of hiding it.
		["aborted", "CH90.0%"],
		// Rounding never claims a full read that did not happen.
		["nearly", "CH99.9%"],
	])("shows the latest reply of the branch at leaf %s", (leaf, expected) => {
		const out = stripAnsi(new FooterComponent(sessionAt(leaf), data).render(160).join("\n"));
		expect(out).toContain(expected);
	});
});
