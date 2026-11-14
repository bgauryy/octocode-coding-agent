import { visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// Color assertions exercise a color-capable terminal, independent of the invoking shell.
beforeEach(() => {
	vi.stubEnv("NO_COLOR", "");
	vi.stubEnv("TERM", "xterm-256color");
	vi.stubEnv("COLORTERM", "truecolor");
});
afterEach(() => vi.unstubAllEnvs());

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
	kind?: string;
	contextPercent?: number;
	routedModel?: { model: { id: string }; thinkingLevel?: string };
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: options.contextPercent ?? 12.3 }),
		routedModel: options.routedModel,
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
			getProviderKind: () => options.kind ?? (options.usingSubscription ? "subscription" : "API key"),
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("footer statuses as data", () => {
	it("paints each status in its tone with the live theme", () => {
		initTheme("dark");
		const footer = new FooterComponent(createSession({ sessionName: "test" }), {
			...createFooterData(1),
			getState: () => ({
				branch: "main",
				providerCount: 1,
				statuses: new Map([
					["a-jobs", { text: "2 bash jobs", tone: "accent" as const }],
					["b-lint", { text: "lint ok" }],
				]),
			}),
			subscribe: () => () => {},
		});
		const out = footer.render(120).join("\n");
		expect(out).toContain(theme.fg("accent", "2 bash jobs"));
		expect(stripAnsi(out)).toContain("2 bash jobs lint ok");
	});

	it("shows an error before routine statuses when the status line is clipped", () => {
		initTheme("dark");
		const footer = new FooterComponent(createSession({ sessionName: "test" }), {
			...createFooterData(1),
			getState: () => ({
				branch: "main",
				providerCount: 1,
				statuses: new Map([
					["a-routine", { text: "routine background status", tone: "muted" as const }],
					["z-error", { text: "team unavailable", tone: "error" as const }],
				]),
			}),
			subscribe: () => () => {},
		});
		const narrow = footer.render(20).at(-1)!;
		expect(stripAnsi(narrow)).toMatch(/^team unavailable/);
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(20);
		expect(stripAnsi(footer.render(80).at(-1)!)).toBe("routine background status team unavailable");
	});
});

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeEach(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows the physical model a virtual model routed to", () => {
		const session = createSession({
			sessionName: "",
			modelId: "auto",
			reasoning: true,
			thinkingLevel: "high",
			routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const output = stripAnsi(footer.render(120).join("\n"));
		expect(output).toContain("Coordinator · thinking high · test/auto");
		expect(output).toContain("Latest route · gpt-5.6-luna · thinking medium");
	});

	it.each([24, 32, 40])("keeps coordinator model and thinking visible in a %s-column footer", (width) => {
		const session = createSession({
			sessionName: "",
			modelId: "gpt-5",
			provider: "openai",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12345678,
				output: 12345678,
				cacheRead: 12345678,
				cacheWrite: 12345678,
				cost: { total: 12345.678 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const lines = footer.render(width);
		const output = lines.map(stripAnsi).join("\n");
		expect(output).toContain(width < 27 ? "Main · think high" : "Coordinator · thinking high");
		expect(output).toContain("openai/gpt-5");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("explicitly labels models without thinking support", () => {
		const session = createSession({ sessionName: "", reasoning: false });
		expect(new FooterComponent(session, createFooterData(1)).render(100).map(stripAnsi).join("\n")).toContain(
			"thinking unavailable",
		);
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("≈$1.25");
	});

	it("updates cached usage totals after an entry is appended", () => {
		const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
		const session = createSession({ sessionName: "", usage });
		const footer = new FooterComponent(session, createFooterData(1));
		expect(stripAnsi(footer.render(120)[1])).toContain("≈$0.50");

		session.sessionManager.getEntries().push({ type: "message", message: { role: "assistant", usage } } as never);
		expect(stripAnsi(footer.render(120)[1])).toContain("≈$1.00");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);
		expect(statsLine).toContain("CH25.0%");
	});

	// The runtime's plan billing decides (model-runtime-plan-billing.test.ts); the footer shows its answer.
	it("marks Kimi Coding costs as subscription estimates when the runtime bills it by plan", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usingSubscription: true,
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("≈$1.23 (sub)");
	});

	it("marks explicitly identified subscription auth", () => {
		const session = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[1])).toContain("≈$0.00 (sub)");
	});

	it("names the provider's kind beside the model and drops it first when narrow", () => {
		const session = createSession({ sessionName: "", modelId: "gpt-5", provider: "openai", kind: "subscription" });
		const footer = new FooterComponent(session, createFooterData(1));
		expect(stripAnsi(footer.render(120).join("\n"))).toContain("openai/gpt-5 · subscription");
		const narrow = stripAnsi(footer.render(55).join("\n"));
		expect(narrow).toContain("Coordinator · thinking unavailable · openai/gpt-5");
		expect(narrow).toContain("openai/gpt-5");
		expect(narrow).not.toContain("subscription");
	});

	it("does not mark generic OAuth sign-in as a subscription", () => {
		const session = createSession({
			sessionName: "",
			provider: "openrouter",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[1]);

		expect(stats).toContain("≈$1.23");
		expect(stats).not.toContain("(sub)");
	});
});

describe("footer text conventions", () => {
	const colorOf = (line: string) => line.match(/\x1b\[[0-9;]*m(?=[^\x1b]*\d+\.\d%\/200k)/)?.[0];

	it("formats tokens like the Octocode footer and joins the session name with a middle dot", () => {
		const usage = { input: 12_400, output: 2_000, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
		const output = new FooterComponent(createSession({ sessionName: "demo", usage }), createFooterData(1))
			.render(120)
			.map(stripAnsi);

		expect(output[0]).toContain("/tmp/project (main) · demo");
		expect(output[1]).toContain("↑12.4k ↓2k");
		expect(output.join("")).not.toContain("•");
	});

	it("truncates with an ellipsis, not three dots", () => {
		const lines = new FooterComponent(createSession({ sessionName: "a-long-session-name" }), createFooterData(1))
			.render(14)
			.map(stripAnsi);

		expect(lines[0]).toMatch(/…$/);
		expect(lines.join("")).not.toContain("...");
	});

	it("colours context by the Octocode thresholds: plain below 50, warning from 50, error above 80", () => {
		const paint = (contextPercent: number) =>
			colorOf(
				new FooterComponent(createSession({ sessionName: "", contextPercent }), createFooterData(1)).render(120)[1],
			);
		const [low, mid, high] = [paint(49.9), paint(50), paint(80.1)];

		expect(paint(80)).toBe(mid);
		expect(new Set([low, mid, high]).size).toBe(3);
	});
});
