# Propagation and metrics

Part of the [`@octocodeai/octocode-telemetry` guide](../README.md).

## Propagation and Span Links

An adapter may also implement `TelemetryPropagation`. Expose it through `context.propagation` so code can inject or extract using the context it already has. The root, spans, and extracted parents share the adapter's capability object:

```typescript
interface TelemetryPropagation {
	inject(context: TelemetryContext): TelemetryCarrier | undefined;
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext;
}
type TelemetryCarrier = Record<string, string>;
```

A carrier is an opaque JSON-safe string map. Adapters own its format; W3C `traceparent` and `tracestate` fit without requiring them. Transport code sends only the carrier, never a context or span:

```typescript
const caller = new InMemoryTelemetryContext();
const provider = new InMemoryTelemetryContext();
await caller.startSpan({ name: "rpc.client" }, async (span) => {
	const wire = JSON.stringify(caller.inject(span));
	await provider.extract(JSON.parse(wire)).startSpan({ name: "rpc.server" }, (serverSpan) => handleRequest(serverSpan));
});
```

Injection returns a detached carrier or `undefined` for roots, no-op contexts, and unsupported contexts. Extraction returns a receiver-owned parent. Absent or unknown carriers fall back to the adapter's root. Extraction checks only that required carrier keys contain strings; identifiers are opaque and need no format validation. Both methods are synchronous. Trace metadata is diagnostics, never authorization. Transport boundaries own carrier size limits.

A link relates work without changing its parent. Use `SpanOptions.links` when the target is known at creation, or `span.addLink()` after the span has started:

```typescript
await telemetry.startSpan(
	{ name: "activation", links: [{ context: firstGetter, attributes: { reason: "trigger" } }] },
	async (activation) => {
		laterGetter.addLink({ context: activation });
		await activate();
	},
);
```

Link targets are `TelemetryContext` handles, including spans and extracted remote parents. For a remote link, first call `adapter.extract(carrier)`. A settled target remains linkable and injectable; a settled source ignores `addLink()`. Links append in order, copy attributes, and ignore root, no-op, or unsupported contexts. The typed span starter's callback also supports `addLink()`; initial links use the low-level `startSpan()` API.

`NOOP_TELEMETRY_PROPAGATION` ignores its arguments: injection returns `undefined`, extraction returns `NOOP_TELEMETRY_CONTEXT`.

## Metrics

An adapter may implement `TelemetryMetrics` alongside `TelemetryContext` and `TelemetryPropagation`. Applications configure one adapter, not separate backends for each capability. Expose the shared capability through `context.metrics`; child spans retain it, so nested model calls can record metrics without a separate configuration option. The in-memory adapter also implements the factory methods directly:

```typescript
const bytes = telemetry.counter("network.bytes", {
	description: "Encoded WebSocket bytes",
	unit: "By",
});
bytes.add(encodedSize, { direction: "out" });

const active = telemetry.upDownCounter("calls.active");
active.add(1);
active.add(-1);

const duration = telemetry.histogram("call.duration", {
	unit: "ms",
	boundaries: [1, 10, 100, 1000],
});
duration.record(elapsedMs, { method: "read" }, currentSpan);
```

Factories take an instrument name and optional `InstrumentOptions` (`description`, `unit`). Histograms additionally accept `HistogramOptions.boundaries`: callers supply finite, strictly increasing bucket hints. Backends own aggregation and may translate these hints. Callers are responsible for finite measurements and non-negative counter increments; up-down counters and histograms may use signed values. Histogram `record(value, attributes?, context?)` optionally correlates a measurement with a span, called an exemplar. Counter `add(value, attributes?)` has no context argument.

Factories and recording methods are synchronous and trust typed inputs. Adapters need not validate measurement values, metadata, attributes, or boundaries; malformed inputs have unspecified behavior. `NOOP_TELEMETRY_METRICS` returns shared frozen instruments that discard measurements. Record only values already available to business code; do not serialize or measure extra data for telemetry.

Use only low-cardinality attributes: bounded values such as direction or method, not request IDs, user IDs, prompts, or arbitrary paths. The low-level attribute bag remains open; instrumentation owns this policy, not backend-specific heuristics.

### Typed metric schemas

`TelemetrySchemaDefinition.metrics` optionally declares instrument names, kinds, metadata, and required/optional attributes. `createTypedMetrics()` combines one or more schemas and rejects duplicate metric names, incorrect instrument kinds, unknown attributes, and missing required attributes at compile time:

```typescript
const schema = defineTelemetrySchema({
	version: 1,
	spans: {},
	metrics: {
		"network.bytes": {
			kind: "counter",
			description: "Encoded bytes",
			unit: "By",
			attributes: {
				direction: {
					type: "string",
					required: true,
					values: ["in", "out"],
					description: "Direction",
					cardinality: "low",
				},
			},
		},
	},
} as const);

const metrics = createTypedMetrics(telemetry, [schema]);
metrics.counter("network.bytes").add(encodedSize, { direction: "out" });
```

Metric definitions use `kind: 'counter' | 'upDownCounter' | 'histogram'`; only histograms may declare `boundaries`. Metric attributes use the same scalar/array definitions as spans, but reject `cardinality: 'high'`. Omitting the cardinality annotation does not waive the low-cardinality policy. Unlike the typed span starter, the metric helper reads and retains schema instrument metadata at runtime. It performs no runtime attribute validation.

`InMemoryTelemetryContext.getMetrics()` returns ordered, detached `RecordedTelemetryMeasurement` snapshots: `kind`, `name`, optional `description`/`unit`/`boundaries`, `value`, copied `attributes`, and a carrier-shaped exemplar `context` or `null`. This is a measurement log, not aggregated counters or buckets; storage is unbounded. Measurement times are retained privately for store queries, not exposed in these snapshots.
