import { validateToolArguments } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { registerWebTool } from "../../src/octocode/native/tools/web/tool.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { settleReason } from "../../src/octocode/shared/reason.ts";
import { fakeHost, fakePermission } from "./fake-host.ts";

const web = Type.Object({ url: Type.String(), maxChars: Type.Optional(Type.Number()) });
const bash = Type.Object({
	command: Type.String(),
	timeout: Type.Optional(Type.Integer()),
	background: Type.Optional(Type.Boolean()),
	opts: Type.Optional(Type.Object({ a: Type.Number() })),
	list: Type.Optional(Type.Array(Type.String())),
});
const p = (name: string, value: string) => `<parameter name="${name}">${value}`;

describe("parameter text leaked into reason", () => {
	it("lifts a web url and keeps set values", () => {
		const args = { reason: `Read docs.</reason>\n${p("url", "https://example.com/x")}`, maxChars: 10000 };
		expect(settleReason(args, "web", web)).toEqual({
			reason: "Read docs.",
			url: "https://example.com/x",
			maxChars: 10000,
		});
	});

	it("lifts bash fields with their declared types", () => {
		const reason = `Run it</reason>\n${p("command", "ls -la")}</parameter>\n${p("timeout", "30")}</parameter>\n${p("background", "true")}</parameter>\n${p("opts", '{"a":1}')}</parameter>\n${p("list", '["x"]')}</parameter>`;
		expect(settleReason({ reason }, "bash", bash)).toEqual({
			reason: "Run it",
			command: "ls -la",
			timeout: 30,
			background: true,
			opts: { a: 1 },
			list: ["x"],
		});
	});

	it("never overwrites a set property and skips undeclared names", () => {
		const args = { reason: `Why ${p("command", "new")}${p("nope", "x")}`, command: "old" };
		expect(settleReason(args, "bash", bash)).toBe(args);
	});

	it("skips values that do not fit the declared type but lifts the rest", () => {
		const reason = `Why ${p("timeout", "soon")}${p("opts", "{bad")}${p("command", "ls")}`;
		expect(settleReason({ reason }, "bash", bash)).toEqual({ reason: "Why", command: "ls" });
	});

	it("leaves a reason without a leak byte-identical", () => {
		const args = { reason: "Run <b>tests</b>", command: "ls" };
		expect(settleReason(args, "bash", bash)).toBe(args);
	});

	it("passes validation on a registered web tool after lifting", () => {
		const fake = fakeHost();
		Object.assign(fake.api.tools, { getActive: () => [] });
		registerWebTool(withNativePermissionOwners(fake.api), fakePermission("full"));
		const tool = fake.tools.get("web")!;
		const raw = { reason: `Read docs.</reason>\n${p("url", "https://example.com/x")}`, maxChars: 10000 };
		const prepared = tool.prepareArguments!(raw) as Record<string, unknown>;
		expect(prepared).toEqual({ reason: "Read docs.", url: "https://example.com/x", maxChars: 10000 });
		expect(() =>
			validateToolArguments(tool as never, { type: "toolCall", id: "c", name: "web", arguments: prepared as never }),
		).not.toThrow();
	});
});
