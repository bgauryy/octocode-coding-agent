import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { estimateSuite, formatEstimate, ratesFor, readModelCost, runCost } from "../lib/estimate.mjs";

function sandbox(t) {
	const dir = mkdtempSync(join(tmpdir(), "oc-estimate-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const catalog = join(dir, "catalog");
	mkdirSync(catalog);
	writeFileSync(
		join(catalog, "anthropic.json"),
		JSON.stringify({
			"anthropic-messages": {
				"chat:fake-main": { cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
				"chat:claude-sonnet-5-5": { cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
				"chat:claude-haiku-5-5": { cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
			},
		}),
	);
	return { dir, catalog };
}

test("prices: catalog lookup, context tiers, time-limited rates, and the cost formula", (t) => {
	const { dir, catalog } = sandbox(t);
	assert.equal(readModelCost(catalog, "claude-sonnet-5-5").input, 2);
	assert.equal(
		readModelCost(catalog, "my-provider/claude-sonnet-5-5").input,
		2,
		"a custom provider falls back on the id",
	);
	assert.throws(() => readModelCost(catalog, "unknown-model"), /not in the catalog/);
	assert.throws(() => readModelCost(join(dir, "absent"), "x"), /hydrate/);

	const tiered = {
		input: 1,
		tiers: [
			{ inputTokensAbove: 100, input: 5 },
			{ inputTokensAbove: 200, input: 9 },
		],
	};
	assert.equal(ratesFor(tiered, 100).input, 1);
	assert.equal(ratesFor(tiered, 101).input, 5);
	assert.equal(ratesFor(tiered, 500).input, 9);
	const limited = { input: 1, until: "2026-01-01", after: { input: 2 } };
	assert.equal(ratesFor(limited, 0, Date.parse("2026-01-01T12:00:00Z")).input, 1);
	assert.equal(ratesFor(limited, 0, Date.parse("2026-01-02T00:00:00Z")).input, 2);

	// One request: the prompt written at twice the input rate, plus output.
	const cost = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
	const one = runCost({ cost, requests: 1, firstPrompt: 45_000, meanPrompt: 45_000, output: 500, cacheHit: 1 });
	assert.ok(Math.abs(one - (0.36 + 0.01)) < 1e-9, String(one));
	// Later requests read the cached share.
	const two = runCost({ cost, requests: 2, firstPrompt: 45_000, meanPrompt: 45_000, output: 500, cacheHit: 1 });
	assert.ok(Math.abs(two - one - (0.009 + 0.01)) < 1e-9, String(two));
});

test("the estimate grows with runs, adds children and states its basis", (t) => {
	const { catalog } = sandbox(t);
	const direct = { id: "a", kind: "question" };
	const delegating = { id: "b", kind: "question", delegates: "implementer" };
	const one = estimateSuite({ tasks: [direct], runs: 1, model: "fake-main", catalogDir: catalog });
	assert.ok(one.low > 0 && one.low < one.high);
	const twice = estimateSuite({ tasks: [direct], runs: 2, model: "fake-main", catalogDir: catalog });
	assert.ok(Math.abs(twice.high - one.high * 2) < 1e-9);
	const child = estimateSuite({ tasks: [delegating], runs: 1, model: "fake-main", catalogDir: catalog });
	assert.ok(child.high > 0);
	assert.ok(Object.keys(child.prices).some((name) => name.includes("implementer")));
	assert.match(formatEstimate(one), /2 arms/);
});
