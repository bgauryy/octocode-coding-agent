import assert from "node:assert/strict";
import { test } from "node:test";
import { gateReasons, missingLiveScripts, violations } from "./check-live-tests.mjs";

const at = (file, text) => ({ file, text });
const offline = { include: ["test/**/*.test.ts"], exclude: ["**/node_modules/**", "**/*.live.test.{ts,tsx}"] };

test("catches a credential-gated test that a default config would collect", () => {
	const fake = at(
		"test/fake.test.ts",
		'describe.skipIf(!process.env.ANTHROPIC_API_KEY)("calls the provider", () => {});',
	);
	const found = violations("ai/vitest.config.ts", [fake], { include: ["test/**/*.test.ts"] });
	assert.equal(found.length, 1);
	assert.match(found[0], /^ai\/vitest\.config\.ts: test\/fake\.test\.ts: skipIf\/runIf on credentials/);
});

test("catches a live file whose config does not exclude it, and accepts one that does", () => {
	const live = at("test/zen.live.test.ts", "");
	assert.deepEqual(violations("x", [live], { include: ["test/**/*.test.ts"] }), [
		"x: test/zen.live.test.ts: live file",
	]);
	assert.deepEqual(violations("x", [live], offline), []);
});

test("catches the other ways a test reaches credentials", () => {
	assert.ok(gateReasons('const LIVE = process.env.TESTKIT_LIVE === "1";').length);
	assert.ok(gateReasons('import { resolveApiKey } from "./oauth.ts";').length);
	assert.ok(gateReasons("const enabled = Boolean(process.env.ANTHROPIC_API_KEY);").length);
	assert.ok(gateReasons('it.skipIf(!hasBedrockCredentials())("x", () => {});').length);
});

test("leaves offline tests alone, including ones that only set a fake key or skip on the platform", () => {
	assert.deepEqual(gateReasons('process.env.BASETEN_API_KEY = "test-baseten-key";'), []);
	assert.deepEqual(gateReasons('it.runIf(process.platform !== "win32")("posix", () => {});'), []);
	assert.deepEqual(gateReasons('describe.skipIf(process.env.OCTOCODE_E2E_CHROME !== "1")("chrome", () => {});'), []);
});

test("requires a test:live script wherever live tests exist", () => {
	const files = [at("test/a.live.test.ts", "")];
	assert.deepEqual(missingLiveScripts([{ name: "ai", files, scripts: { test: "vitest" } }]), [
		"ai: has live tests but no test:live script",
	]);
	assert.deepEqual(missingLiveScripts([{ name: "ai", files, scripts: { "test:live": "vitest" } }]), []);
	assert.deepEqual(missingLiveScripts([{ name: "db", files: [at("test/a.test.ts", "")], scripts: {} }]), []);
});
