import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { getExportTemplateDir } from "../src/config.ts";
import { readTemplateScript } from "../src/core/export-html/template-script.ts";

const template = readTemplateScript(getExportTemplateDir());

function renderTool(parameters?: object): string {
	// Exercise the export's real header and escaping functions without booting its browser event loop.
	const escape = template.match(/^([ \t]*)function escapeHtml\(text\) \{[\s\S]*?^\1\}/m)?.[0];
	const header = template.match(/^([ \t]*)function renderHeader\(\) \{[\s\S]*?^\1\}/m)?.[0];
	expect(escape).toBeDefined();
	expect(header).toBeDefined();
	return runInNewContext(`${escape}\n${header}\nrenderHeader()`, {
		globalStats: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokens: {}, models: [], toolCalls: 0 },
		header: {},
		thinkingExpanded: false,
		toolOutputsExpanded: false,
		showHiddenMessages: false,
		systemPrompt: "",
		tools: [{ name: "agent", description: "Delegate", parameters }],
	}) as string;
}

describe("exported tool parameter details", () => {
	it.each(["anyOf", "oneOf", "allOf"])(
		"keeps object-root %s schemas expandable with their full constraints",
		(keyword) => {
			const html = renderTool({
				type: "object",
				[keyword]: [
					{ properties: { type: { const: "task" }, input: { type: "object" } }, additionalProperties: false },
					{ required: ["type", "input"] },
				],
			});
			expect(html).toContain('class="tool-params-hint"');
			expect(html).toContain(`&quot;${keyword}&quot;`);
			expect(html).toContain("&quot;const&quot;: &quot;task&quot;");
			expect(html).toContain("&quot;additionalProperties&quot;: false");
			expect(html).toContain("&quot;required&quot;");
		},
	);

	it("escapes composed schema text even when it also has top-level properties", () => {
		const html = renderTool({
			type: "object",
			properties: { reason: { type: "string" } },
			anyOf: [{ description: "</pre><script>alert(1)</script>" }],
		});
		expect(html).toContain("&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
	});

	it("preserves ordinary property rows and their required labels", () => {
		const html = renderTool({
			type: "object",
			properties: { query: { type: "string", description: "What to find" } },
			required: ["query"],
		});
		expect(html).toContain('<span class="tool-param-name">query</span>');
		expect(html).toContain('<span class="tool-param-required">required</span>');
		expect(html).toContain('<div class="tool-param-desc">What to find</div>');
		expect(html).not.toContain("<pre");
	});

	it.each([undefined, { type: "object", properties: {} }, { type: "object", anyOf: [] }])(
		"does not offer empty parameter details for %j",
		(parameters) => expect(renderTool(parameters)).not.toContain('class="tool-params-hint"'),
	);
});
