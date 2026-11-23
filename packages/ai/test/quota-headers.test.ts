import { describe, expect, it } from "vitest";
import { parseQuotaHeaders, quotaWindowLabel } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

describe("parseQuotaHeaders", () => {
	it("reads ChatGPT plan windows from x-codex headers", () => {
		const resetAt = Math.floor(NOW / 1000) + 2 * 3600;
		const readings = parseQuotaHeaders(
			"openai",
			{
				"x-codex-primary-used-percent": "62",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(resetAt),
				"x-codex-secondary-used-percent": "18.5",
				"x-codex-secondary-window-minutes": "10080",
			},
			NOW,
		);
		expect(readings).toEqual([
			{
				provider: "openai",
				window: "primary",
				label: "5h",
				usedFraction: 0.62,
				resetsAt: resetAt * 1000,
				kind: "plan",
				source: "header",
				observedAt: NOW,
			},
			{
				provider: "openai",
				window: "secondary",
				label: "week",
				usedFraction: 0.185,
				kind: "plan",
				source: "header",
				observedAt: NOW,
			},
		]);
	});

	it("clamps a plan window used past its cap and labels a window without a length by its id", () => {
		const [reading] = parseQuotaHeaders("openai", { "x-codex-primary-used-percent": "130" }, NOW);
		expect(reading).toMatchObject({ window: "primary", label: "primary", usedFraction: 1 });
	});

	it("reads Anthropic rate limits with RFC 3339 resets", () => {
		const readings = parseQuotaHeaders(
			"anthropic",
			{
				"anthropic-ratelimit-requests-limit": "4000",
				"anthropic-ratelimit-requests-remaining": "3000",
				"anthropic-ratelimit-requests-reset": "2026-11-23T12:00:30Z",
				"anthropic-ratelimit-input-tokens-limit": "2000000",
				"anthropic-ratelimit-input-tokens-remaining": "1500000",
				"anthropic-ratelimit-input-tokens-reset": "not a time",
				"anthropic-ratelimit-output-tokens-limit": "400000",
			},
			NOW,
		);
		expect(readings).toEqual([
			{
				provider: "anthropic",
				window: "requests",
				label: "requests",
				usedFraction: 0.25,
				resetsAt: Date.UTC(2026, 10, 23, 12, 0, 30),
				kind: "rate",
				source: "header",
				observedAt: NOW,
			},
			{
				provider: "anthropic",
				window: "input-tokens",
				label: "input tokens",
				usedFraction: 0.25,
				kind: "rate",
				source: "header",
				observedAt: NOW,
			},
		]);
	});

	it("reads OpenAI rate limits whose resets are durations", () => {
		const readings = parseQuotaHeaders(
			"openai",
			{
				"x-ratelimit-limit-requests": "60",
				"x-ratelimit-remaining-requests": "45",
				"x-ratelimit-reset-requests": "1s",
				"x-ratelimit-limit-tokens": "150000",
				"x-ratelimit-remaining-tokens": "149984",
				"x-ratelimit-reset-tokens": "6m0s",
				"x-ratelimit-limit-project-tokens": "60000",
				"x-ratelimit-remaining-project-tokens": "30000",
				"x-ratelimit-reset-project-tokens": "1h2m3.5s",
			},
			NOW,
		);
		expect(readings.map(({ window, usedFraction, resetsAt }) => ({ window, usedFraction, resetsAt }))).toEqual([
			{ window: "requests", usedFraction: 0.25, resetsAt: NOW + 1_000 },
			{ window: "tokens", usedFraction: expect.closeTo(0.000107, 6), resetsAt: NOW + 360_000 },
			{ window: "project-tokens", usedFraction: 0.5, resetsAt: NOW + 3_723_500 },
		]);
		expect(new Set(readings.map((reading) => reading.kind))).toEqual(new Set(["rate"]));
	});

	it("reads Groq-style fractional and bare-second resets, and drops a reset it cannot read", () => {
		const readings = parseQuotaHeaders(
			"groq",
			{
				"x-ratelimit-limit-requests": "14400",
				"x-ratelimit-remaining-requests": "14370",
				"x-ratelimit-reset-requests": "2m59.56s",
				"x-ratelimit-limit-tokens": "18000",
				"x-ratelimit-remaining-tokens": "17997",
				"x-ratelimit-reset-tokens": "7",
				"x-ratelimit-limit-project-tokens": "100",
				"x-ratelimit-remaining-project-tokens": "50",
				"x-ratelimit-reset-project-tokens": "soon",
			},
			NOW,
		);
		expect(readings.map((reading) => reading.resetsAt)).toEqual([NOW + 179_560, NOW + 7_000, undefined]);
	});

	it("returns nothing when no family's headers are present or a limit is unusable", () => {
		expect(parseQuotaHeaders("openai", { "content-type": "text/event-stream" }, NOW)).toEqual([]);
		expect(
			parseQuotaHeaders(
				"openai",
				{
					"x-ratelimit-limit-requests": "0",
					"x-ratelimit-remaining-requests": "0",
					"x-codex-primary-used-percent": "",
				},
				NOW,
			),
		).toEqual([]);
	});
});

describe("quotaWindowLabel", () => {
	it.each([
		[300, "5h"],
		[10080, "week"],
		[43200, "30d"],
		[1440, "1d"],
		[90, "90m"],
	])("labels %i minutes as %s", (minutes, label) => {
		expect(quotaWindowLabel(minutes)).toBe(label);
	});
});
