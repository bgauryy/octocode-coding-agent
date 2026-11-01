# Typed schemas

Part of the [`@octocodeai/octocode-telemetry` guide](../README.md).

## Typed Schemas

The low-level span API intentionally accepts open names and attribute bags so adapters remain generic. Domain packages can define closed, serializable schemas and infer exact TypeScript types from them.

```typescript
import { createTypedSpanStarter, defineTelemetrySchema } from "@octocodeai/octocode-telemetry";

export const EXAMPLE_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"example.read": {
			description: "Read one resource",
			parents: { kind: "any" },
			startAttributes: {
				"example.resource": {
					type: "string",
					required: true,
					values: ["account", "project"],
					description: "Resource kind",
				},
			},
			endAttributes: {
				"example.item_count": {
					type: "number",
					description: "Number of returned items",
				},
			},
			events: {
				"example.cache": {
					description: "Cache lookup result",
					attributes: {
						"example.cache.hit": {
							type: "boolean",
							required: true,
							description: "Whether the cache contained the resource",
						},
					},
				},
			},
			status: {
				default: "ok",
				errorWhen: "The read throws or returns an error result",
			},
		},
	},
} as const);

const startSpan = createTypedSpanStarter(telemetryContext, [EXAMPLE_TELEMETRY_SCHEMA]);
```

The starter exposes one overload per span and checks names and attributes at compile time. Union-valued names must be narrowed before a call, preserving the relationship between each runtime name and its attribute schema. Its callback receives a child starter over the same schemas, already bound to the callback span:

```typescript
await startSpan("example.read", { "example.resource": "account" }, async (span, startChildSpan) => {
	span.addEvent("example.cache", { "example.cache.hit": true });
	const accounts = await readAccounts();
	span.setAttributes({ "example.item_count": accounts.length });

	await startChildSpan("example.read", { "example.resource": "project" }, async (childSpan) => {
		const projects = await readProjects();
		childSpan.setAttributes({ "example.item_count": projects.length });
	});

	return accounts;
});
```

### Start and Completion Attributes

`startAttributes` and `endAttributes` describe when an attribute is normally known, not separate runtime storage:

| Schema field      | How values are recorded                                                      | Requiredness                                                |
| ----------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `startAttributes` | Passed in the typed starter's `attributes` argument when the span is created | Each definition explicitly sets `required: true` or `false` |
| `endAttributes`   | Added later through the schema-scoped span's `setAttributes()` method        | Always optional                                             |

Both sets become ordinary attributes on the same backend span. There is no separate end-attribute payload or end callback. In the preceding example, `example.resource` is known when `example.read` starts, while `example.item_count` is known only after `readAccounts()` returns:

```typescript
await startSpan(
	"example.read",
	{ "example.resource": "account" }, // required start attribute
	async (span) => {
		const accounts = await readAccounts();
		span.setAttributes({
			"example.item_count": accounts.length, // optional completion attribute
		});
		return accounts;
	},
); // resolving the callback settles the span
```

“End” means completion enrichment: an end attribute may be set at any point while the callback is active, and it may be omitted when unavailable. Calling `setAttributes()` zero times is valid. This matters for early failures, cancellation, and provider-specific data that may not exist on every path.

Repeated `setAttributes()` calls merge into the same attribute bag. A later defined value replaces an earlier value for the same key, while `undefined` is ignored. The schema-scoped method accepts only the current span's declared end attributes.

Attributes do not end the span. Returning, resolving, throwing, or rejecting from the callback controls settlement; `startSpan()` performs the actual end operation. Adapter calls made after settlement are inert.

A starter can compose multiple independently versioned schemas:

```typescript
import { AGENT_TELEMETRY_SCHEMAS } from "@octocodeai/octocode-agent-core";

const startAgentSpan = createTypedSpanStarter(telemetryContext, AGENT_TELEMETRY_SCHEMAS);
```

Inline schema arrays retain their tuple types automatically. Separately declared arrays should use `as const`. Literal duplicate span names across the array are rejected at compile time; schemas are not merged, inspected, or retained at runtime.

Schema-derived types reject missing required attributes, unknown keys, invalid closed-set values, undeclared events, and attributes on empty schemas. End attributes are always optional enrichment; the type system does not require `setAttributes()` to be called.

`defineTelemetrySchema()` is a typed identity function. It returns ordinary JSON-serializable data and performs no runtime validation or parent-rule enforcement.

## Schema Metadata

Supported attribute types are:

- `string`, `number`, and `boolean`;
- `string[]`, `number[]`, and `boolean[]`.

Attribute definitions support:

- `values`: a closed set for scalar values;
- `elementValues`: a closed set for array elements;
- `examples`: documentation examples;
- `sensitive`: marks data requiring special handling;
- `cardinality`: records expected `low` or `high` cardinality.

Start and event attributes declare `required`. End attributes do not; see [Start and Completion Attributes](#start-and-completion-attributes).

Parent metadata is descriptive schema data:

- `{ kind: 'any' }`: root or any caller span;
- `{ kind: 'root_or_external' }`: root or a caller-owned span outside the schema;
- `{ kind: 'spans', spans: [...] }`: only the listed schema spans.

Adapters do not need to understand schema objects. Instrumentation helpers and tests use them to keep emitted names and attributes consistent.
