import assert from "node:assert/strict";
import test from "node:test";
import { moduleSpecifiers, rewriteModuleSpecifiers } from "./module-specifiers.mjs";

test("finds static, deferred, CommonJS and type-only module sources", () => {
	const source = `
import "side-effect";
import type { A } from /* type */ "types";
export { B } from 'named';
export * as namespace from "namespace";
export * from "all";
const deferred = import /* deferred */ ("dynamic");
const template = import(\`template\`);
const cjs = require /* cjs */ ('commonjs');
import legacy = require("legacy");
type Imported = import /* type */ ("import-type").T;
`;
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["side-effect", "types", "named", "namespace", "all", "dynamic", "template", "commonjs", "legacy", "import-type"],
	);
});

test("ignores ordinary strings, comments, property calls and computed imports", () => {
	const source = `
const help = "import 'example'";
const template = \`export * from 'example'\`;
// import "comment";
/* require("comment"); */
object.require("method");
import(name);
import(\`./\${name}\`);
`;
	assert.deepEqual(moduleSpecifiers(source, "fixture.js"), []);
});

test("distinguishes CommonJS loaders from locally shadowed require functions", () => {
	const shadowed = `
const require = (value) => value;
require("not-a-module");
function withParameter(require) { require("also-not-a-module"); }
{
	const require = () => undefined;
	require("block-local");
}
`;
	assert.deepEqual(moduleSpecifiers(shadowed, "fixture.ts"), []);
	const loader = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require("actual-commonjs-module");
`;
	assert.deepEqual(
		moduleSpecifiers(loader, "fixture.ts").map((specifier) => specifier.value),
		["node:module", "actual-commonjs-module"],
	);
});

test("handles JSX and declaration-file syntax", () => {
	const sources = [
		["fixture.tsx", 'import { A } from "view"; export const view = <A />;'],
		["fixture.jsx", 'import { A } from "view"; export const view = <A />;'],
		["fixture.d.ts", 'declare module "virtual" { export type A = import("view").A; }'],
	];
	for (const [filename, source] of sources)
		assert.deepEqual(
			moduleSpecifiers(source, filename).map((specifier) => specifier.value),
			["view"],
		);
});

test("decodes escaped paths and preserves all surrounding source and quote styles", () => {
	const source = String.raw`// π 🚀 import '../private';
const example = "import '../private'";
import '../pr\u0069vate';
export * from "../private";
const pending = import /* defer */ (\`../private\`);
`.replaceAll("\\`", "`");
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["../private", "../private", "../private"],
	);
	const rewritten = rewriteModuleSpecifiers(source, "fixture.ts", () => "./mounted");
	assert.equal(
		rewritten,
		`// π 🚀 import '../private';
const example = "import '../private'";
import './mounted';
export * from "./mounted";
const pending = import /* defer */ (\`./mounted\`);
`,
	);
	assert.equal(
		rewriteModuleSpecifiers(source, "fixture.ts", (specifier) => specifier),
		source,
	);
});

test("escapes replacement paths without changing their value or interpreting template syntax", () => {
	const replacement = "./quote'\"backtick`template${x}backslash\\";
	const rewritten = rewriteModuleSpecifiers(
		`import './old'; export * from "./old"; const pending = import(\`./old\`);`,
		"fixture.ts",
		() => replacement,
	);
	assert.deepEqual(
		moduleSpecifiers(rewritten, "fixture.ts").map((specifier) => specifier.value),
		[replacement, replacement, replacement],
	);
});

test("rejects syntax errors rather than silently returning a partial import graph", () => {
	assert.throws(() => moduleSpecifiers('import { from "missing";', "broken.ts"), /Parse failed/);
});

for (const source of [
	'function fixture(require) { return require("./data"); }',
	'const fixture = (require) => require("./data");',
	'const require = (value) => value; require("./data");',
	'let require = (value) => value; require("./data");',
	'var require = (value) => value; require("./data");',
	'function fixture() { require("./data"); if (true) { var require; } }',
	'function require(value) { return value; } require("./data");',
	'const fixture = function require() { return require("./data"); };',
	'try {} catch (require) { require("./data"); }',
	'const {require} = helpers; require("./data");',
	'let {load: require = fallback} = helpers; require("./data");',
	'const [require] = helpers; require("./data");',
	'function fixture({load: require}) { return require("./data"); }',
	'function fixture(...require) { return require("./data"); }',
	'for (const require of helpers) { require("./data"); }',
]) {
	test(`preserves calls to locally bound require: ${source}`, () => {
		assert.deepEqual(moduleSpecifiers(source, "fixture.ts"), []);
		assert.equal(
			rewriteModuleSpecifiers(source, "fixture.ts", () => "./changed"),
			source,
		);
	});
}

test("imported require bindings are ordinary calls while actual import sources remain dependencies", () => {
	const source = 'import {load as require} from "helper"; require("./data");';
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["helper"],
	);
});

test("local bindings do not suppress CommonJS calls outside their scope", () => {
	const source = `
require("before");
{ const require = helper; require("data"); }
function fixture(require) { return require("data"); }
try {} catch (require) { require("data"); }
for (let require of helpers) { require("data"); }
require("after");
`;
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["before", "after"],
	);
});

test("recognizes a real createRequire import and rejects a shadowed factory", () => {
	const source = `
import { createRequire as makeRequire } from "node:module";
const require = makeRequire(import.meta.url);
require("real-module");
function fixture(makeRequire) {
  const require = makeRequire(import.meta.url);
  return require("data");
}
`;
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["node:module", "real-module"],
	);
});

test("visits imports in every function expression and type position", () => {
	const source = `
function load(value = import("parameter")): import("return-type").T { return {}; }
const arrow = ({ [require("computed-key")]: value = import("destructured-default") } = {}) => value;
function annotated(value: import("parameter-type").T) {}
`;
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["parameter", "return-type", "computed-key", "destructured-default", "parameter-type"],
	);
});

test("export wrappers do not hide hoisted or lexical bindings", () => {
	for (const declaration of [
		"export const require = (value) => value;",
		"export let require = (value) => value;",
		"export var require = (value) => value;",
		"export function require(value) { return value; }",
		"export class require {}",
		"export default function require(value) { return value; }",
	]) {
		assert.deepEqual(moduleSpecifiers(`require("data"); ${declaration}`, "fixture.ts"), []);
	}
});

test("switch lexical bindings cover all cases and stay outside the discriminant and following code", () => {
	const source = `
switch (require("discriminant")) {
  case 0: require("data-before"); break;
  default: const require = helper; require("data-after");
}
require("after-switch");
`;
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["discriminant", "after-switch"],
	);
});

test("class expression names and static variables do not leak outside their scopes", () => {
	for (const declaration of [
		'const Named = class require { method() { require("class-data"); } };',
		'class Fixture { static { require("static-data"); var require; } }',
	]) {
		const source = `${declaration}\nrequire("after-class");`;
		assert.deepEqual(
			moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
			["after-class"],
		);
	}
});

test("function body bindings do not hide CommonJS calls in parameter defaults", () => {
	const source = 'function load(value = require("parameter")) { var require; require("body-data"); }';
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["parameter"],
	);
});

test("loop initializers and destructuring defaults retain their import expressions", () => {
	const source = `
for (const value of import("iterable")) { require("body"); }
for (const { item = import("default") } of values) {}
for (const require of values) { require("local-data"); }
require("after-loop");
`;
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["iterable", "body", "default", "after-loop"],
	);
});

test("rewrites control characters with JavaScript escapes for every quote style", () => {
	const replacement = "./line\u2028separator\u2029control\u0000\t\b\f\v\n\r";
	const rewritten = rewriteModuleSpecifiers(
		`import './old'; export * from "./old"; const pending = import(\`./old\`);`,
		"fixture.ts",
		() => replacement,
	);
	assert.deepEqual(
		moduleSpecifiers(rewritten, "fixture.ts").map((specifier) => specifier.value),
		[replacement, replacement, replacement],
	);
});

test("recognizes namespace createRequire factories without treating type-only bindings as values", () => {
	const source = `
import * as nodeModule from "node:module";
import type { require } from "types";
require("global-module");
function load() {
  const require = nodeModule.createRequire(import.meta.url);
  return require("created-module");
}
`;
	assert.deepEqual(
		moduleSpecifiers(source, "fixture.ts").map((specifier) => specifier.value),
		["node:module", "types", "global-module", "created-module"],
	);
});
