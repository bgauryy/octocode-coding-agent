# @octocodeai/octocode-telemetry

Vendor-neutral telemetry contracts and typed schema utilities for Octocode packages.

This library supplies contracts and implementations; the host chooses what to collect and export. Coding-agent preferences and environment overrides are documented in [CONFIGURATIONS.md](../../CONFIGURATIONS.md) and [environment variables](../coding-agent/docs/environment-variables.md).

This package provides:

- an explicit, callback-based `TelemetryContext` / `TelemetrySpan` contract;
- a shared `NOOP_TELEMETRY_CONTEXT`;
- opaque cross-process propagation and span links;
- counters, up-down counters, histograms, and typed metric schemas;
- a reference `InMemoryTelemetryContext` implementation;
- serializable schema definitions with inferred TypeScript types;
- no exporter, global current-span state, or dependency on a telemetry backend.

Applications can use the in-memory reference or provide an adapter for OpenTelemetry, Sentry, logs, or another backend. Octocode packages pass telemetry contexts explicitly and define their domain schemas separately.

## Documentation

This README covers installation, the concepts and the core context API. Further pages:

| Page                                                       | Covers                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Adapters](docs/adapters.md)                               | The adapter contract, the no-op context, the in-memory reference adapter, stored telemetry, adapter conformance |
| [Propagation and metrics](docs/propagation-and-metrics.md) | Cross-process propagation, span links, counters, histograms, typed metric schemas                               |
| [Typed schemas](docs/schemas.md)                           | Span schemas, start and completion attributes, schema metadata                                                  |
| [API reference](docs/api-reference.md)                     | Exported types, values, schema helpers and the testing subpath                                                  |

## Installation

```bash
npm install @octocodeai/octocode-telemetry
```

## Telemetry Concepts

Telemetry describes what a program did while it was running. This package models that work using spans, attributes, events, statuses, and explicit context:

| Concept                    | Plain-language meaning                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Span**                   | A timed record of one operation, such as loading an account or making an AI request. It begins before the work and ends when the work finishes.                      |
| **Parent and child spans** | Operations can contain smaller operations. A request span might contain a cache lookup and a database query. Together they form a tree showing where time was spent. |
| **Attribute**              | A named fact attached to a span, such as `provider: "openai"`, `cache.hit: true`, or `item_count: 12`. Attributes describe the operation and its result.             |
| **Event**                  | A named occurrence at a point during a span, such as `retry.scheduled` or `cache.lookup`. Events have no duration and may carry their own attributes.                |
| **Status**                 | The operation's outcome: `ok` or `error`. An error status may include an error name and message.                                                                     |
| **Context**                | A handle identifying where new work belongs in the span tree. Starting a span from a context makes it a child of that context.                                       |

For example, loading an account could produce this telemetry:

```text
example.account.load                         span
├─ attributes: account.id=123, found=true   facts about the span
├─ event: example.cache.lookup              occurrence during the span
│  └─ attribute: cache.hit=false            fact about the event
└─ status: ok                               final outcome
```

A span is diagnostic data, not business state. An adapter translates these generic concepts into the corresponding concepts used by OpenTelemetry, Sentry, logs, or another backend.

## Core Context API

A `TelemetryContext` starts a span around a callback. The callback receives a `TelemetrySpan`, which is also the explicit parent context for child spans. Contexts optionally expose their adapter's `metrics?: TelemetryMetrics` and `propagation?: TelemetryPropagation` capabilities; child spans and extracted parents carry the same capabilities. A `TelemetryContext` adapter starts root spans; hosts retain this adapter. Invocation contexts and octocode-ai request options carry a `TelemetrySpan`, never the adapter. A tracing adapter that only implements `startSpan()` is still valid.

```typescript
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@octocodeai/octocode-telemetry";

async function loadAccount(accountId: string, telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT) {
	return telemetryContext.startSpan(
		{
			name: "example.account.load",
			attributes: { "example.account.id": accountId },
		},
		async (span) => {
			const account = await readAccount(accountId);
			span.setAttributes({ "example.account.found": account !== undefined });
			return account;
		},
	);
}
```

Pass the callback span to lower-level work to create explicit nesting:

```typescript
return telemetryContext.startSpan({ name: "example.parent" }, async (parentSpan) => {
	return parentSpan.startSpan({ name: "example.child" }, async (childSpan) => {
		childSpan.addEvent("example.cache.lookup", { "example.cache.hit": true });
		return performWork();
	});
});
```

There is no public `end()` method. `startSpan()` owns settlement and keeps the span open until the callback's value or promise settles. For an expected failure represented by a normal return value, set the status explicitly:

```typescript
return telemetryContext.startSpan({ name: "example.save" }, async (span) => {
	const result = await save();
	if (!result.ok) {
		span.setStatus({
			status: "error",
			error: { name: "SaveError", message: result.reason },
		});
	}
	return result;
});
```

## Package integration

Package ownership is intentionally split:

- `@octocodeai/octocode-telemetry` owns the vendor-neutral contract, no-op and in-memory reference contexts, schema utilities, and adapter conformance suite;
- `@octocodeai/octocode-ai` accepts a parent `TelemetrySpan` through `telemetry` in provider request options and exports `AI_TELEMETRY_SCHEMA` from its root and `./models` entry points;
- `@octocodeai/octocode-agent-core` retains its existing agent-loop and session instrumentation and schemas.

```typescript
import { AI_TELEMETRY_SCHEMA } from "@octocodeai/octocode-ai/models";
```

The AI schema uses `pi.ai.*` names, kept from the upstream project. Adapters may translate them to backend conventions without changing the emitted vocabulary.

## Security and Portability

Telemetry is diagnostics, not durable application state. Do not persist a `TelemetryContext`, `TelemetrySpan`, or backend-native trace object in records, messages, snapshots, or deferred handles. An injected `TelemetryCarrier` may cross a transport or be stored as optional diagnostic correlation data. Changing adapters may lose correlation; carriers are not application state.

Attribute values are intentionally limited to primitive scalars and arrays. Domain instrumentation should avoid prompts, completions, tool arguments or output, file contents, provider payloads, headers, credentials, and free-form error details unless its schema and data policy explicitly allow them.

The package does not use `AsyncLocalStorage` or another runtime-specific ambient context API. It is suitable for Node.js, Bun, browsers, and workers; backend adapters remain responsible for their own runtime compatibility.

## Development

From this package directory:

```bash
yarn test
yarn run build
```

Repository-wide type checking, formatting, linting, and smoke checks run with:

```bash
yarn run check
```

## License

MIT
