# API Reference

Part of the [`@octocodeai/octocode-telemetry` guide](../README.md).

## Core types and values

| Export                                        | Purpose                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `TelemetryContext`                            | Starts callback-managed child spans and optionally exposes adapter metrics/propagation |
| `TelemetrySpan`                               | Records attributes, events, and status; also acts as a child context                   |
| `SpanOptions`                                 | Span name, optional start attributes and links                                         |
| `SpanLink`                                    | Context target and optional link attributes                                            |
| `TelemetryCarrier`                            | Opaque JSON-safe string map                                                            |
| `TelemetryPropagation`                        | Optional adapter injection and extraction capability                                   |
| `NOOP_TELEMETRY_PROPAGATION`                  | Shared passive propagation for disabled telemetry                                      |
| `TelemetryMetrics`                            | Optional adapter instrument factories                                                  |
| `TelemetryCounter` / `TelemetryUpDownCounter` | Instruments with `add()`                                                               |
| `TelemetryHistogram`                          | Instrument with `record()` and optional exemplar context                               |
| `InstrumentOptions` / `HistogramOptions`      | Description, unit, and histogram boundary hints                                        |
| `NOOP_TELEMETRY_METRICS`                      | Shared passive metric instruments                                                      |
| `RecordedTelemetryMeasurement`                | Captured measurement and optional exemplar                                             |
| `SpanAttributes` / `AttributeValue`           | Open adapter-level attribute bag and supported values                                  |
| `SpanStatus`                                  | Explicit `ok` or `error` status                                                        |
| `NOOP_TELEMETRY_CONTEXT`                      | Shared passive context for disabled telemetry                                          |
| `InMemoryTelemetryContext`                    | Reference adapter with deterministic process-local recording                           |
| `RecordedTelemetrySpan`                       | Normalized captured span snapshot                                                      |
| `RecordedTelemetryEvent`                      | Normalized captured event snapshot                                                     |
| `RecordedTelemetryLink`                       | Captured target carrier and link attributes                                            |
| `TelemetryStore`                              | Settled trace discovery, trace retrieval, and metric queries                           |
| `StoredSpan` / `StoredTrace`                  | Backend-independent timed span and trace snapshots                                     |
| `TraceQuery` / `MetricQuery`                  | Trace filters, pagination, and metric filters                                          |
| `StoredMetric`                                | Metric interval row with count, sum, minimum, and maximum                              |

## Schema definitions and inference

| Export                                                             | Purpose                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `defineTelemetrySchema()`                                          | Typed identity helper for serializable schema data                         |
| `createTypedSpanStarter()`                                         | Binds a parent context to one or more schema vocabularies                  |
| `createTypedMetrics()` / `TypedTelemetryMetrics`                   | Binds metric names, kinds, metadata, and attributes to schemas             |
| `TelemetryMetricDefinition` / `TelemetryMetricAttributeDefinition` | Serializable instrument metadata and low-cardinality attribute definitions |
| `SchemaTelemetryCounter` / `SchemaTelemetryHistogram`              | Schema-constrained recording methods                                       |
| `TypedSpanStarter`                                                 | Exact starter type with recursively child-bound callbacks                  |
| `TelemetrySchemaDefinition`                                        | Top-level schema shape                                                     |
| `TelemetrySpanDefinition`                                          | Span metadata, parents, attributes, events, and status rule                |
| `TelemetryAttributeType`                                           | Supported scalar and array type names                                      |
| `TelemetryAttributeMetadata`                                       | Description, sensitivity, and cardinality metadata                         |
| `TelemetryAttributeDefinition`                                     | Attribute type, allowed values, examples, and metadata                     |
| `TelemetryStartAttributeDefinition`                                | Start attribute definition with requiredness                               |
| `TelemetryEventAttributeDefinition`                                | Event attribute definition with requiredness                               |
| `TelemetryEventDefinition`                                         | Event description and attribute definitions                                |
| `TelemetryParentDefinition`                                        | Open, external-root, or finite schema-parent rule                          |
| `TelemetrySchemaSpanName`                                          | Union of declared span names                                               |
| `TelemetrySchemaSpanStartAttributes`                               | Exact inferred start attributes for one span                               |
| `TelemetrySchemaSpanEndAttributes`                                 | Optional inferred end attributes for one span                              |
| `TelemetrySchemaSpanEventName`                                     | Union of events declared by one span                                       |
| `TelemetrySchemaSpanEventAttributes`                               | Exact inferred attributes for one event                                    |
| `SchemaTelemetrySpan`                                              | Span view restricted to one schema span                                    |
| `TelemetrySchemaSpanUnion`                                         | Discriminated union of all spans in a schema                               |
| `InferStartAttributes`                                             | Required and optional values inferred from start definitions               |
| `InferOptionalAttributes`                                          | Optional values inferred from end definitions                              |
| `InferEventAttributes`                                             | Required and optional values inferred from event definitions               |
| `InferRequiredAndOptionalAttributes`                               | Shared inference utility for definitions with requiredness                 |
| `ExactTelemetryAttributes`                                         | Rejects keys outside an expected attribute set                             |

## Testing subpath

| Export                                | Purpose                                                   |
| ------------------------------------- | --------------------------------------------------------- |
| `createTelemetryAdapterConformance()` | Creates runner-independent adapter conformance cases      |
| `TelemetryAdapterFixture`             | Fresh context and normalized snapshot reader for one case |
| `TelemetryAdapterFixtureFactory`      | Creates isolated fixtures                                 |
| `TelemetryAdapterConformanceCase`     | Grouped case that test runners execute                    |
