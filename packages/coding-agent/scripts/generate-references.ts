#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CompatSchemasByApi } from "@octocodeai/octocode-ai/providers/compat-schema";
import { ModelInputLimitsSchema } from "@octocodeai/octocode-ai/providers/model-schema";
import type { TSchema } from "typebox";
import { ModelsJsonSchemas } from "../src/core/model-config.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { RpcCommandSchema } from "../src/modes/rpc/rpc-command-schema.ts";
import {
	hookEventsIntro,
	hookEventTable,
	hookFieldsList,
	hookInputTable,
	hookUpstreamOnlyList,
} from "./reference-pages/hook-events.ts";
import { rpcCommandDescriptions, rpcIntro, rpcProtocol } from "./reference-pages/rpc.ts";
import {
	settingDefaults,
	settingDescriptions,
	settingsGroups,
	settingsIntro,
	settingsPrivacyNote,
} from "./reference-pages/settings.ts";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const generatedComment =
	"This file is generated from TypeScript source. Do not edit it manually; run yarn run generate:references.";

/** The subset of JSON Schema that reference pages render. */
interface ReferenceSchema {
	type?: string;
	const?: unknown;
	enum?: readonly unknown[];
	anyOf?: readonly ReferenceSchema[];
	items?: ReferenceSchema;
	properties?: Readonly<Record<string, ReferenceSchema>>;
	required?: readonly string[];
	description?: string;
	default?: unknown;
}

interface ReferenceSection {
	heading: string;
	intro?: string;
	/** Object schema whose properties become table rows. */
	schema?: TSchema;
	/** Top-level fields whose type links to another section instead of listing nested fields. */
	links?: Readonly<Record<string, string>>;
	/** Top-level fields listed without their nested fields. */
	collapsed?: readonly string[];
	/** Restrict the table to these top-level fields. */
	fields?: readonly string[];
	/** Restrict the table to the top-level fields no other section lists. */
	rest?: true;
	/** Descriptions for fields whose schema has none, keyed by dotted path. */
	descriptions?: Readonly<Record<string, string>>;
	/** Defaults for fields whose schema declares none, keyed by dotted path. */
	defaults?: Readonly<Record<string, unknown>>;
	/** Markdown placed after the intro, instead of a schema table; a function runs at render time. */
	body?: string | (() => string);
}

interface ReferenceArtifact {
	path: `docs/${string}.md`;
	title: string;
	intro: string;
	sections: readonly ReferenceSection[];
}

/** APIs grouped by the compatibility schema they share, in first-seen order. */
const compatSchemaApis = new Map<TSchema, string[]>();
for (const [api, schema] of Object.entries(CompatSchemasByApi)) {
	compatSchemaApis.set(schema, [...(compatSchemaApis.get(schema) ?? []), api]);
}

const formatList = (items: readonly string[]) =>
	items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");

const referenceArtifacts: readonly ReferenceArtifact[] = [
	{
		path: "docs/models-configuration.md",
		title: "Models Configuration",
		intro: [
			"This reference lists the fields of `models.json`. See [Configure a compatible endpoint](models.md#configure-a-compatible-endpoint) for examples and [Configuration](configuration.md#agent-directory) for the file location.",
			"For editor validation and completion, point `$schema` at `schemas/models.schema.json` in the installed Octocode package.",
		].join("\n\n"),
		sections: [
			{
				heading: "Providers",
				intro:
					'Each key under `providers` is a provider ID. `models.json` defines custom providers: each ID adds a provider, which needs `baseUrl` and an `api` at provider or model level. An official provider ID (such as `anthropic` or `amazon-bedrock`) is refused with a message and the other providers in the file still load; rename the entry for a custom endpoint, and set an official provider\'s host or key in `/providers`. What an official ID may carry is tuning and throttling: `modelOverrides` and `defaults` limited to `compat`, `contextWindow`, `maxTokens`, `inputLimits` and `cost` (a negotiated or enterprise price, with `tiers`, `until` and `after` as below; `/model` details mark it "(your price)"), and `requestsPerMinute` and `tokensPerMinute` at provider level and in `modelOverrides`. Host, API, key, headers, `auth`, `env` and `models` stay refused.',
				schema: ModelsJsonSchemas.provider,
				links: {
					models: "#models",
					modelOverrides: "#model-overrides",
					defaults: "#provider-defaults-and-profiles",
					compat: "#compatibility",
				},
			},
			{
				heading: "Models",
				intro:
					"Each `models` entry adds a model to the provider. An entry whose `id` names a known model (the provider's own, else the built-in model of the vendor its `api` belongs to: Anthropic, OpenAI, Google, Azure, Vertex, Mistral or Bedrock; `claude-opus-5.5`, `claude-opus-5-5` and `anthropic/claude-opus-5-5` name one model) starts from that model's context window, output limit, thinking map, input types, prices, input limits and compatibility; the fields you set win. Cache lifetimes and long cache retention of a direct provider do not carry to another host: set `promptCache` and `compat.supportsLongCacheRetention` when your host honours them. The defaults listed below apply to a model Octocode does not know.",
				schema: ModelsJsonSchemas.model,
				links: { inputLimits: "#input-limits", compat: "#compatibility" },
			},
			{
				heading: "Model overrides",
				intro:
					"Each `modelOverrides` key is the ID of a built-in model. Unknown IDs are ignored. Object fields, such as `cost`, merge with the model's value field by field; other fields replace it. A `cost` override that sets any rate or `tiers` also drops the model's built-in `until`/`after` price window, so your rates stay in force after the built-in date; set `until` and `after` in the override to give it a window of its own.",
				schema: ModelsJsonSchemas.modelOverride,
				links: { inputLimits: "#input-limits", compat: "#compatibility" },
			},
			{
				heading: "Provider defaults and profiles",
				intro: [
					"`defaults` on a provider sets model fields once for every model of that provider, built-in and custom: `contextWindow`, `maxTokens`, `input`, `cost`, `thinkingLevelMap`, `promptCache`, `inputLimits`, `samplingParams`, `compat` and `reasoning`. For one field the order is: the model's own entry, its `modelOverrides` entry, the provider's `defaults`, then built-in model data. Object fields merge key by key; other fields replace.",
					"A provider may sit in several files. They merge field by field, the narrower one winning each field it names: Octocode's project file, Pi's project file, Octocode's global files, then Pi's global files. Pi's own `models.json` loads unchanged. A project file may add models and tune defaults, but it may not change `baseUrl`, `api`, `headers`, `apiKey`, `auth` or `env` of a provider a global file also defines (nor a model's `baseUrl`, `api` or `headers`): those fields are ignored with a warning naming the file, so a project cannot send a stored key to another host. A provider only the project defines sets its own.",
					"`tokensPerMinute` caps the tokens a model uses per minute across all sessions on the machine (uncached input plus output; cache reads are not counted). A request over the budget waits. A model's value wins over its provider's; for Bedrock Kimi, which has a built-in budget, `OCTOCODE_BEDROCK_KIMI_TPM` still overrides both.",
					"`profile` names the provider family whose cache markers, cache lifetimes and request quirks a provider's models follow: `anthropic`, `openai`, `bedrock`, `openrouter`, `vercel`, `opencode`, `groq`, `xiaomi`, `zai`, `together`, `moonshot`, `cloudflare-workers-ai`, `cloudflare-ai-gateway`, `nvidia`, `ant-ling`, `cerebras`, `deepseek`, `xai` or `chutes`. Use it for a gateway that serves another provider's models (a Claude gateway takes `anthropic` and gets Anthropic cache markers and the 1h tier). Without it the profile is detected from the provider id and host, as before. An explicit `compat` value always wins over the profile, and the order for a model field is: model entry, `modelOverrides`, `defaults`, the profile, built-in model data. An official provider may set `profile` (it moves no key or host); a project file may set it on a provider a global file defines.",
					"`thinkingLevelMap` in `defaults` maps thinking levels to provider values for every model of the provider. A request for a level the map marks `null` is sent as the nearest lower supported level, or as the lowest supported one when none is lower.",
					"When an endpoint answers 400 that it does not accept `cache_control` markers, strict tool schemas or an effort setting, Octocode resends that request once without the field (it failed before any reply), remembers the rejection for the endpoint and model until the process ends, and leaves the field out of later requests.",
				].join("\n\n"),
				schema: ModelsJsonSchemas.defaults,
				links: { inputLimits: "#input-limits", compat: "#compatibility" },
			},
			{
				heading: "Input limits",
				intro: "See [Describe model input and caching](models.md#describe-model-input-and-caching).",
				schema: ModelInputLimitsSchema,
			},
			{
				heading: "Compatibility",
				intro:
					"`compat` describes verified differences from an API's standard request and response behavior. Model values override provider values per field. The fields that apply depend on the model's `api`.",
			},
			...[...compatSchemaApis].map(([schema, [api, ...aliases]]) => ({
				heading: `### \`${api}\``,
				intro:
					aliases.length > 0 ? `Also applies to ${formatList(aliases.map((alias) => `\`${alias}\``))}.` : undefined,
				schema,
				collapsed: ["openRouterRouting", "vercelGatewayRouting"],
			})),
		],
	},
	{
		path: "docs/settings.md",
		title: "Settings",
		intro: settingsIntro,
		sections: [
			...settingsGroups.map(({ heading, intro, fields, rest }) => ({
				heading,
				intro,
				schema: SettingsSchema,
				fields,
				rest,
				descriptions: settingDescriptions,
				defaults: settingDefaults,
			})),
			{ heading: "Telemetry and privacy", body: settingsPrivacyNote },
		],
	},
	{
		path: "docs/rpc.md",
		title: "RPC Mode",
		intro: rpcIntro,
		sections: [
			{ heading: "Protocol", body: rpcProtocol },
			{ heading: "Commands", body: rpcCommandTable },
		],
	},
	{
		path: "docs/hook-events.md",
		title: "Hook Events",
		intro: hookEventsIntro,
		sections: [
			{ heading: "Events and handler types", body: hookEventTable },
			{ heading: "Host metadata in the input", body: hookInputTable },
			{ heading: "Command handler fields", body: hookFieldsList },
			{ heading: "Upstream events not implemented yet", body: hookUpstreamOnlyList },
		],
	},
];

function referenceType(schema: ReferenceSchema): string {
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
	if (schema.anyOf) return [...new Set(schema.anyOf.map(referenceType))].join(" | ");
	if (schema.type === "array") {
		const item = schema.items ? referenceType(schema.items) : "unknown";
		return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
	}
	return schema.type ?? "unknown";
}

/** Whether a field, or anything nested in it, carries documentation in the schema or the section's overrides. */
function hasDocumentation(field: ReferenceSchema, path: string, section: ReferenceSection): boolean {
	if (field.description !== undefined || field.default !== undefined) return true;
	if (section.descriptions?.[path] !== undefined || section.defaults?.[path] !== undefined) return true;
	const nested = field.properties ?? field.anyOf?.find((branch) => branch.properties)?.properties ?? {};
	return Object.entries(nested).some(([name, child]) => hasDocumentation(child, `${path}.${name}`, section));
}

/** Nested object whose fields get their own rows, if any of them carry documentation. */
function documentedObject(
	schema: ReferenceSchema,
	path: string,
	section: ReferenceSection,
): { suffix: string; schema: ReferenceSchema } | undefined {
	if (schema.type === "array") {
		const item = schema.items && documentedObject(schema.items, `${path}[]`, section);
		return item && { suffix: `[]${item.suffix}`, schema: item.schema };
	}
	const object = schema.properties ? schema : schema.anyOf?.find((branch) => branch.properties);
	const documented = Object.entries(object?.properties ?? {}).some(([name, field]) =>
		hasDocumentation(field, `${path}.${name}`, section),
	);
	return object && documented ? { suffix: "", schema: object } : undefined;
}

const escapeTableText = (text: string) => text.replaceAll("|", "\\|").replaceAll("<", "&lt;");

function referenceRows(
	schema: ReferenceSchema,
	section: ReferenceSection,
	prefix = "",
	names?: readonly string[],
): string[] {
	const rows: string[] = [];
	for (const [name, field] of Object.entries(schema.properties ?? {})) {
		if (names && !names.includes(name)) continue;
		const path = `${prefix}${name}`;
		const link = prefix === "" ? section.links?.[name] : undefined;
		const type = escapeTableText(referenceType(field));
		const typeText = /^[a-z]+$/.test(type) ? type : `\`${type}\``;
		const fieldDefault = field.default ?? section.defaults?.[path];
		const defaultText = fieldDefault === undefined ? "" : `\`${escapeTableText(JSON.stringify(fieldDefault))}\``;
		const description = [
			schema.required?.includes(name) ? "Required." : undefined,
			field.description ?? section.descriptions?.[path],
		]
			.filter((text) => text !== undefined)
			.join(" ");
		rows.push(
			`| \`${path}\` | ${link ? `[${typeText}](${link})` : typeText} | ${defaultText} | ${escapeTableText(description)} |`,
		);
		if (link || (prefix === "" && section.collapsed?.includes(name))) continue;
		const nested = documentedObject(field, path, section);
		if (nested) rows.push(...referenceRows(nested.schema, section, `${path}${nested.suffix}.`));
	}
	return rows;
}

/** One row per RPC command: its fields (`?` marks optional ones) and the description from `rpcCommandDescriptions`. */
function rpcCommandTable(): string {
	const rows = RpcCommandSchema.anyOf.map((member) => {
		const schema = member as unknown as ReferenceSchema;
		const properties = Object.entries(schema.properties ?? {});
		const name = String(properties.find(([key]) => key === "type")?.[1].const);
		const description = rpcCommandDescriptions[name];
		if (description === undefined) throw new Error(`rpc.ts has no description for RPC command "${name}"`);
		const fields = properties
			.filter(([key]) => key !== "type" && key !== "id")
			.map(([key, field]) => `\`${key}${schema.required?.includes(key) ? "" : "?"}\`: ${referenceType(field)}`);
		return `| \`${name}\` | ${fields.map(escapeTableText).join("<br>")} | ${escapeTableText(description)} |`;
	});
	return ["| Command | Fields | Description |", "|---|---|---|", ...rows].join("\n");
}

function renderReference(artifact: ReferenceArtifact): string {
	const blocks = [`# ${artifact.title}`, `<!-- ${generatedComment} -->`, artifact.intro];
	const listed = new Set(artifact.sections.flatMap((section) => section.fields ?? []));
	for (const section of artifact.sections) {
		blocks.push(section.heading.startsWith("#") ? section.heading : `## ${section.heading}`);
		if (section.intro) blocks.push(section.intro);
		if (typeof section.body === "function") blocks.push(section.body());
		else if (section.body) blocks.push(section.body);
		if (section.schema) {
			const names = section.rest
				? Object.keys((section.schema as ReferenceSchema).properties ?? {}).filter((name) => !listed.has(name))
				: section.fields;
			const rows = referenceRows(section.schema, section, "", names);
			blocks.push(["| Field | Type | Default | Description |", "|---|---|---|---|", ...rows].join("\n"));
		}
	}
	return `${blocks.join("\n\n")}\n`;
}

export function renderReferences(): ReadonlyMap<string, string> {
	return new Map(referenceArtifacts.map((artifact) => [artifact.path, renderReference(artifact)]));
}

function generateReferences(): void {
	for (const [relativePath, content] of renderReferences()) {
		const path = resolve(packageDirectory, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf-8");
		console.log(`Generated packages/coding-agent/${relativePath}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	generateReferences();
}
