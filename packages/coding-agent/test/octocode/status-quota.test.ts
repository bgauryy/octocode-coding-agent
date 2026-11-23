import { fauxAssistantMessage, type QuotaReading } from "@octocodeai/octocode-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderQuotas, providerQuotas, type QuotaStore } from "../../src/core/model-runtime/quota-request.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { statusCommand } from "../../src/octocode/status-command.ts";
import { resetClock } from "@octocodeai/octocode-common/time";
import { quotaLines, sessionProviders } from "../../src/octocode/status-quota.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

beforeAll(() => initTheme("dark"));
// Reset times read as local clock times: pin the zone so the expected text is the same on every machine.
beforeEach(() => vi.stubEnv("TZ", "UTC"));
afterEach(() => vi.unstubAllEnvs());

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const NOW_S = NOW / 1000;

const emptyStore = (): QuotaStore => ({ read: () => [], readSince: () => [], write: async () => {} });

/** ChatGPT plan headers: a 5-hour window 62 % used, resetting at 14:20 UTC, and a weekly one 18 % used. */
const codexHeaders = (resetAt: number) => ({
	"x-codex-primary-used-percent": "62",
	"x-codex-primary-window-minutes": "300",
	"x-codex-primary-reset-at": String(resetAt),
	"x-codex-secondary-used-percent": "18",
	"x-codex-secondary-window-minutes": "10080",
	"x-codex-secondary-reset-at": String(NOW_S + 4 * 86_400 - 3 * 3_600),
});

describe("the Quota section", () => {
	it("shows one line per provider with readings in force, plan windows with their reset", () => {
		const quotas = new ProviderQuotas(emptyStore, () => NOW);
		quotas.recordHeaders("openai", codexHeaders(NOW_S + 2 * 3_600 + 20 * 60));
		quotas.recordHeaders("anthropic", {
			"anthropic-ratelimit-requests-limit": "4000",
			"anthropic-ratelimit-requests-remaining": "3000",
			"anthropic-ratelimit-requests-reset": "2026-11-23T12:00:30Z",
		});
		// Provider names are padded to the longest, so every provider's windows start in one column.
		expect(quotaLines(["openai", "anthropic", "google"], quotas)).toEqual([
			"Quota",
			"  openai     5h 62% · resets 14:20 · week 18% · resets Fri 09:00",
			"  anthropic  requests 25%",
		]);
	});

	it("is empty when no provider has a reading in force", () => {
		const quotas = new ProviderQuotas(emptyStore, () => NOW);
		expect(quotaLines(["openai"], quotas)).toEqual([]);
		const stale: QuotaReading = {
			provider: "openai",
			window: "primary",
			label: "5h",
			usedFraction: 0.9,
			resetsAt: NOW - 1,
			kind: "plan",
			source: "header",
			observedAt: NOW - 3_600_000,
		};
		quotas.record([stale]);
		expect(quotaLines(["openai"], quotas)).toEqual([]);
	});

	it("names a reset a week or more away by its date", () => {
		expect(resetClock(NOW + 8 * 86_400_000, NOW)).toBe("Dec 1");
	});

	it("lists the session's providers: replies, side calls, the selected model and this process's readings", () => {
		const sessionManager = SessionManager.inMemory(process.cwd());
		sessionManager.appendMessage({ ...fauxAssistantMessage("reply"), provider: "openai" });
		const providers = sessionProviders(sessionManager.getEntries(), "anthropic", { providers: () => ["claude-code"] });
		expect(providers).toEqual(["openai", "anthropic", "claude-code"]);
	});
});

describe("/status", () => {
	it("shows the quota a response of the session's provider reported", async () => {
		const provider = `quota-status-${process.pid}-${Date.now()}`;
		const resetAt = Math.floor(Date.now() / 1000) + 3_600;
		providerQuotas.recordHeaders(provider, {
			"x-codex-primary-used-percent": "62",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": String(resetAt),
		});
		const fake = fakeHost();
		const commands = new Subcommands();
		commands.add(
			"status",
			statusCommand(fake.api, { mode: "full" }, () => "Octocode 1.0"),
		);
		commands.register(fake.api);
		const sessionManager = SessionManager.inMemory(process.cwd());
		sessionManager.appendMessage({ ...fauxAssistantMessage("reply"), provider });
		const ctx = Object.assign(fakeCtx({ cwd: ".", hasUI: true }), {
			sessionManager,
			getContextUsage: () => undefined,
		});
		await fake.commands.get("status")!.handler("", ctx);
		const text: string = ctx.ui.notes[0].message;
		expect(text).toContain(`\nQuota\n  ${provider}  5h 62% · resets ${resetClock(resetAt * 1000, Date.now())}\n`);
	});
});
