Load when writing, validating or debugging an overrides file.

# Overrides format

```json
{
	"server": "Server instructions as plain prose.",
	"tools": {
		"localSearch": "Tool description as plain prose."
	},
	"triggers": {
		"localSearch": "Use to find text matches in local files; for syntax use astSearch."
	},
	"fields": {
		"localSearch": { "responseChars": "Field description." }
	}
}
```

- `server`: replaces the server instructions. Omit to keep them.
- `tools`: tool name as the catalog lists it (usually also the function name; a function after a `// call as` line is named differently) to description. A tool that is not listed keeps its source description. Unknown tool names fail the check.
- `triggers`: tool name to its one-line trigger, the description of the tool's provider declaration ([triggers](rewrite-rules.md#triggers)). The file itself keeps the full description.
- `fields`: tool name to a map from field path to text. Use it for the costliest field docs (see the budget in rewrite-rules). A path joins property names with dots (`queries.filters.createdAt`, `responseChars`); array items, union variants and `$ref`s are transparent, so one path covers every variant that has the field. Start a path with `output.` for a field of the tool's output schema (`output.results.path`). An empty string removes the doc and keeps the constraint note; use it for fields whose name and signature say enough, or whose shared rule moved into the tool description. Text applies only to that tool.
- Descriptions are plain text: no Markdown headings, no tag wrappers, no `*/`.
- Structure never comes from overrides: types, enums, required flags and limits are rendered from the schema.

## What the check enforces

`octocode mcp compact check` runs the product `checkFidelity`: every tool, property, enum or const value, required flag and required-keys alternative from the catalog is present in the rendered file, nothing renders as an unresolved `$ref`, and each override stays within the length limit (server 1,200, tool 600, trigger 200 on one line, field 240) and adds no URL absent from the source. A field override must name a path the schema has (`no such field`) and must not call a field optional that every occurrence requires. It does not judge wording or budget: read the printed tables (whole file, prose against structure, costliest field docs, per description) and apply the budget rules.

## Stored metadata

`octocode mcp compact apply` stores the overrides next to the generated file in `<agent directory>/context-optimization/mcp/<server>.json`, with the catalog hash, a hash per tool, a hash of the instructions and `optimizedBy` (the model that wrote the rewrite). When the catalog changes, a session keeps the overrides of tools whose hash is unchanged and the server text while the instructions are unchanged; the others fall back to the source wording, and `octocode mcp compact list` names them under `stale overrides`.

## Preset form

A preset ships its overrides per tool, each entry with the hash of the tool it describes, so a server release drops only the entries of changed tools:

```json
{
	"server": { "instructionsHash": "<sha256>", "text": "Server instructions as plain prose." },
	"tools": {
		"localSearch": { "hash": "<sha256>", "description": "...", "trigger": "...", "fields": { "responseChars": "..." } }
	}
}
```

Do not compute the hashes by hand: `octocode mcp compact preset <server> --overrides <file> --catalog <file>` checks the overrides and prints this form.
