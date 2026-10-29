import assert from "node:assert/strict";
import test from "node:test";
import { compareToBaseline, countPiTokens } from "./check-pi-names.mjs";

test("counts Pi words and identifier segments", () => {
	const text = [
		"pi.on('x'); this.pi = pi;", // 3
		"Pi settings in ~/.pi/agent", // 2
		"getPiUserAgent PiAnthropic piDir pi_tool_name pi-trust.json", // 5
		"#define PI_NAPI_CALL 1; ATOM_PI", // 2
		"Copyright (c) 2025 Mario Zechner, github.com/earendil-works/pi", // 3
	].join("\n");
	assert.equal(countPiTokens(text), 15);
});

test("ignores unrelated words and mathematical Pi", () => {
	assert.equal(countPiTokens("api pipe spinner Math.PI PIXEL capi ApiKey pick"), 0);
});

test("reports files that grew or shrank against the baseline", () => {
	const { grown, shrunk } = compareToBaseline({ a: 2, b: 1, new: 1 }, { a: 2, b: 3, gone: 1 });
	assert.deepEqual(grown, [{ file: "new", now: 1, allowed: 0 }]);
	assert.deepEqual(shrunk, [
		{ file: "b", now: 1, allowed: 3 },
		{ file: "gone", now: 0, allowed: 1 },
	]);
});
