# Adapters

Part of the [`@octocodeai/octocode-telemetry` guide](../README.md). An adapter bridges the [core context API](../README.md#core-context-api) to a backend.

## Adapter Contract

An adapter implements `TelemetryContext` and bridges the generic API to its backend. Typed inputs are trusted; malformed inputs have unspecified behavior. Adapters are not required to validate inputs or suppress adapter/backend failures.

The callback and recording contract is:

- create a child span and invoke the callback synchronously, exactly once;
- expose optional metric and propagation capabilities on its contexts, child spans, and extracted parents, including inert fallback spans;
- preserve the callback's returned value and rejection value, returning a promise rejected with the same value after a synchronous throw;
- keep the native span open until a returned promise settles;
- treat normal completion as `ok` and throws/rejections as errors unless an explicit status was set;
- make repeated `setStatus()` calls last-write-wins;
- merge `setAttributes()` calls, with later defined values replacing earlier values and `undefined` ignored;
- make recording methods synchronous;
- ignore calls made after settlement.

Adapters may activate backend-native ambient context internally for automatic instrumentation, but Octocode code always propagates the parent through `TelemetryContext` arguments. Exporter buffering, flushing, sampling, backend IDs, and backend-specific context objects belong to the adapter. Use the [adapter conformance suite](#adapter-conformance) to check these observable semantics.

## No-op Context

Use `NOOP_TELEMETRY_CONTEXT` when telemetry is optional:

```typescript
import { NOOP_TELEMETRY_CONTEXT } from "@octocodeai/octocode-telemetry";

const result = await NOOP_TELEMETRY_CONTEXT.startSpan({ name: "example.operation" }, () => runOperation());
```

The no-op context:

- invokes callbacks synchronously;
- preserves returned values and asynchronous rejections, and converts a synchronous throw to a promise rejected with the same value;
- uses one shared frozen inert span, including for nested spans;
- exposes `NOOP_TELEMETRY_METRICS` and `NOOP_TELEMETRY_PROPAGATION` on its root and spans;
- does not inspect or retain names, attributes, events, or statuses.

## In-Memory Reference Adapter

`InMemoryTelemetryContext` is the backend-neutral reference implementation. It is useful for tests, local diagnostics, and applications that intentionally want process-local capture without an exporter:

```typescript
import { InMemoryTelemetryContext } from "@octocodeai/octocode-telemetry";

const telemetry = new InMemoryTelemetryContext();

await telemetry.startSpan({ name: "example.operation", attributes: { input: "demo" } }, async (span) => {
	span.addEvent("example.started");
	span.setAttributes({ output_count: 3 });
});

console.log(telemetry.getSpans());
```

`getSpans()` returns detached snapshots in span-start order. Each `RecordedTelemetrySpan` contains a deterministic numeric ID, local parent ID, carrier-shaped `context` and `parentContext` snapshots, ordered `links`, merged attributes, ordered events, final status, settlement state, and deterministic end sequence. These normalized snapshots expose no timestamps. A remote parent has `parentId: null` but a non-null `parentContext`; a root has both null. A `RecordedTelemetryLink` contains a target carrier and copied attributes.

The adapter implements `TelemetryPropagation` with its own small carrier codec: a unique recorder scope, a deterministic numeric span ID, and an inherited trace ID. The carrier survives JSON round trips and works across independent processes without a shared registry. Its keys are an implementation detail, not a public wire format for other adapters.

The adapter is safe to use as an ordinary `TelemetryContext`, but storage is unbounded and process-local. Create a fresh instance to isolate tests or recording scopes, and do not capture sensitive attributes unless the caller's data policy allows them.

## Stored Telemetry

`TelemetryStore` separates querying from recording. `InMemoryTelemetryContext` implements it:

- `findTraces(query?)` returns complete locally stored traces, newest trace start first. Filters include the earliest stored span's `name`, inclusive `startMin`/`startMax`, `errors: true`, and scalar `attributes`. All requested attributes must match one span, anywhere in the trace. Pages default to 20 traces; pass the returned opaque `cursor` with the same filters to continue. Equal start times are ordered by trace ID.
- `getTrace(traceId)` returns a trace or `undefined`.
- `findMetrics({ name, startMin?, startMax?, attributes? })` returns metric rows with count, sum, minimum, and maximum. Time bounds are inclusive interval-start times. The in-memory adapter maps each raw measurement to a count-one row in its ten-second interval; SQLite aggregates measurements per series and interval.

Only settled spans are returned. A trace ID is the root's globally unique span ID (`<recorder UUID>:<counter>`) and propagates with the parent identity. Stores return the spans available locally: remote or expired parents can be absent, and a child can appear before its parent settles. Pagination is not a snapshot across requests; late settlements and retention can change a trace's earliest stored span. SQLite reads committed rows without implicitly flushing.

`StoredSpan` includes epoch-millisecond `startedMs`/`endedMs`, event offsets in `timeMs`, and links carrying both target `traceId` and `spanId`. Duration uses a monotonic clock; wall clocks across processes may disagree. Merge spans from several stores by trace ID; parent relationships, not timestamp containment, define the tree.

Rendering is a separate subpath, kept out of the root entry graph:

```typescript
import { renderTrace } from "@octocodeai/octocode-telemetry/render";

const page = await telemetry.findTraces({ errors: true, limit: 10 });
for (const trace of page.traces) console.log(renderTrace(trace.spans));
```

`renderTrace()` accepts stored spans, deduplicates IDs, treats absent parents as roots, and prints attributes, durations, statuses, event offsets, and cross-trace links. It never follows links or queries a store.

## Adapter Conformance

`@octocodeai/octocode-telemetry/testing` exports a runner-independent conformance suite modeled as grouped cases. A fixture supplies a fresh context and converts its backend's finished spans into normalized `RecordedTelemetrySpan` snapshots:

```typescript
import {
	createTelemetryAdapterConformance,
	type TelemetryAdapterFixture,
} from "@octocodeai/octocode-telemetry/testing";
import { describe, it } from "vitest";

const conformance = createTelemetryAdapterConformance(async () => {
	const adapter = createMyTelemetryAdapter();
	return {
		context: adapter.context,
		getSpans: async () => adapter.normalizedSpans(),
		async [Symbol.asyncDispose]() {
			await adapter.close();
		},
	} satisfies TelemetryAdapterFixture;
});

for (const group of new Set(conformance.map((testCase) => testCase.group))) {
	describe(group, () => {
		for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
			it(testCase.name, () => testCase.run());
		}
	});
}
```

The suite checks capability identity on roots, child spans, extracted parents and inert spans, synchronous single admission, result and rejection identity, automatic and explicit status, attribute merging, event ordering, inert post-settlement calls, nested and concurrent parentage, and links. Fixtures may supply `propagation` to additionally check JSON round trips, multiple adapter hops, and root fallback for absent or unknown carriers. Fixtures may also supply `metrics` and `getMetrics()` to check ordered measurements, histogram exemplars, and input copying. It does not test malformed inputs or require suppression of adapter/backend failures. `getSpans()` may flush an asynchronous exporter before returning. The testing subpath uses Node's assertion APIs; the root telemetry package remains runtime-neutral.
