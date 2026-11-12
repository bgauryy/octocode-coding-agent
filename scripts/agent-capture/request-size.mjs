#!/usr/bin/env node
/**
 * Sizes model requests the same way for every client: the system text, the message text, each tool's description and
 * its parameter schema as compact JSON. Reads Octocode's rendered contexts (`.octocode/tmp/agent-prompts/<agent>/request.json`,
 * written by `generate:prompts`), request bodies the capture mock logged (`capture.mjs`), or bare Anthropic Messages and
 * OpenAI Responses bodies. Characters, not tokens: about 4 characters per token for English and JSON.
 *
 *   node scripts/agent-capture/request-size.mjs [--tools] [--json] <file or folder>...
 *
 * A folder stands for its `<agent>/request.json` files, or else its `*.json` files.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const compact = (value) => (value === undefined ? "" : JSON.stringify(value));
const textOf = (part) => {
	if (typeof part === "string") return part;
	if (part && ["text", "input_text", "output_text"].includes(part.type)) return part.text ?? "";
	return compact(part);
};
const partsOf = (content) => (Array.isArray(content) ? content : content === undefined ? [] : [content]);

/** One tool's description and schema; a namespace (OpenAI) contributes its nested tools. */
function toolRows(tool) {
	if (tool?.type === "namespace") return (tool.tools ?? []).flatMap(toolRows);
	const {
		name,
		description,
		type,
		input_schema: inputSchema,
		parameters,
		defer_loading: defer,
		strict,
		...rest
	} = tool ?? {};
	// Anthropic `input_schema`, OpenAI and Octocode `parameters`; a custom or built-in tool's other fields (a grammar
	// `format`, say) are its shape.
	const schema = inputSchema ?? parameters ?? rest;
	return [
		{
			name: name ?? type ?? "(unnamed)",
			description: (description ?? "").length,
			schema: Object.keys(schema ?? {}).length > 0 ? compact(schema).length : 0,
			...(defer ? { deferLoading: true } : {}),
		},
	];
}

/** The sizes of one request body, whatever its client. */
export function measureRequest(input) {
	const body = input?.body && (input.url || input.method) ? input.body : input;
	let system = 0;
	let messages = 0;
	const tools = [];
	if (typeof body.system === "string") system += body.system.length;
	else if (Array.isArray(body.system)) system += body.system.reduce((sum, block) => sum + textOf(block).length, 0);
	if (typeof body.instructions === "string") system += body.instructions.length;
	for (const message of body.messages ?? []) {
		// Octocode's rendered request keeps a message's text in `text`.
		if (typeof message.text === "string") messages += message.text.length;
		else messages += partsOf(message.content).reduce((sum, part) => sum + textOf(part).length, 0);
	}
	for (const item of Array.isArray(body.input) ? body.input : []) {
		if (item.type === "additional_tools") tools.push(...(item.tools ?? []).flatMap(toolRows));
		else if ((item.type ?? "message") === "message")
			messages += partsOf(item.content).reduce((sum, part) => sum + textOf(part).length, 0);
		else messages += compact(item).length;
	}
	if (typeof body.input === "string") messages += body.input.length;
	tools.push(...(body.tools ?? []).flatMap(toolRows));
	const toolDescriptions = tools.reduce((sum, tool) => sum + tool.description, 0);
	const toolSchemas = tools.reduce((sum, tool) => sum + tool.schema, 0);
	return {
		system,
		messages,
		toolDescriptions,
		toolSchemas,
		total: system + messages + toolDescriptions + toolSchemas,
		tools,
	};
}

/** The request files a path names, each with a label. */
export function requestFiles(target) {
	const path = resolve(target);
	if (!statSync(path).isDirectory()) return [{ label: target, file: path }];
	const entries = readdirSync(path).sort();
	const agents = entries.filter((entry) => existsSync(join(path, entry, "request.json")));
	if (agents.length > 0)
		return agents.map((agent) => ({ label: `${basename(path)}/${agent}`, file: join(path, agent, "request.json") }));
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => ({ label: `${basename(path)}/${entry}`, file: join(path, entry) }));
}

const number = (value) => value.toLocaleString("en-US");

/** A Markdown table of request totals and, with `tools`, one of every tool by schema size. */
export function formatSizes(rows, { tools = false } = {}) {
	const lines = [
		"| request | system | messages | tool descriptions | tool schemas | total | tools |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
		...rows.map(
			({ label, size }) =>
				`| ${label} | ${number(size.system)} | ${number(size.messages)} | ${number(size.toolDescriptions)} | ${number(size.toolSchemas)} | ${number(size.total)} | ${size.tools.length} |`,
		),
	];
	if (tools)
		for (const { label, size } of rows) {
			lines.push("", `${label}:`, "", "| tool | description | schema |", "| --- | ---: | ---: |");
			for (const tool of [...size.tools].sort((a, b) => b.schema - a.schema || b.description - a.description))
				lines.push(
					`| ${tool.name}${tool.deferLoading ? " (defer_loading)" : ""} | ${number(tool.description)} | ${number(tool.schema)} |`,
				);
		}
	return lines.join("\n");
}

function main() {
	const { values, positionals } = parseArgs({
		options: { tools: { type: "boolean" }, json: { type: "boolean" } },
		allowPositionals: true,
	});
	if (positionals.length === 0) {
		console.error("Usage: request-size.mjs [--tools] [--json] <file or folder>...");
		process.exit(2);
	}
	const rows = positionals
		.flatMap(requestFiles)
		.map(({ label, file }) => ({ label, size: measureRequest(JSON.parse(readFileSync(file, "utf8"))) }));
	console.log(values.json ? JSON.stringify(rows, null, "\t") : formatSizes(rows, { tools: values.tools }));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main();
