import type {
	MetricQuery,
	SpanOptions,
	StoredMetric,
	StoredSpan,
	StoredTrace,
	TelemetryCarrier,
	TelemetryContext,
	TelemetryPropagation,
	TelemetrySpan,
	TelemetryStore,
	TraceQuery,
} from "./context.ts";
import {
	carrierId,
	contextCarriers,
	copyAttributes,
	copyStatus,
	createMeasurementRecorder,
	type InMemoryTelemetryState,
	type RecordedTelemetryMeasurement,
	type RecordedTelemetrySpan,
	startInMemorySpan,
} from "./memory/recording.ts";
import type {
	HistogramOptions,
	InstrumentOptions,
	TelemetryCounter,
	TelemetryHistogram,
	TelemetryMetrics,
	TelemetryUpDownCounter,
} from "./metrics.ts";

export type {
	RecordedTelemetryEvent,
	RecordedTelemetryLink,
	RecordedTelemetryMeasurement,
	RecordedTelemetrySpan,
} from "./memory/recording.ts";

/**
 * Backend-neutral reference implementation that records spans in process memory.
 * Create a fresh instance to isolate tests or independent recording scopes.
 */
export class InMemoryTelemetryContext
	implements TelemetryContext, TelemetryPropagation, TelemetryMetrics, TelemetryStore
{
	readonly metrics: TelemetryMetrics = this;
	readonly propagation: TelemetryPropagation = this;
	private readonly state: InMemoryTelemetryState = {
		metrics: this,
		propagation: this,
		scope: crypto.randomUUID(),
		spans: [],
		measurements: [],
		nextSpanId: 1,
		nextEndSequence: 1,
	};

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return startInMemorySpan(this.state, undefined, options, callback);
	}

	/** Returns a detached carrier for a known span or extracted parent, including settled spans. */
	inject(context: TelemetryContext): TelemetryCarrier | undefined {
		const carrier = contextCarriers.get(context);
		return carrier ? { ...carrier } : undefined;
	}

	/** Missing or non-string carrier identities fall back to this recorder's root context. */
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext {
		const scope = carrier?.["pi-memory-scope"];
		const span = carrier?.["pi-memory-span"];
		const traceId = carrier?.["pi-memory-trace"];
		if (typeof scope !== "string" || typeof span !== "string" || typeof traceId !== "string") return this;
		const context = { "pi-memory-scope": scope, "pi-memory-span": span, "pi-memory-trace": traceId };
		const localId = scope === this.state.scope ? Number(span) : null;
		const parent: TelemetryContext = {
			metrics: this,
			propagation: this,
			startSpan: <T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>) =>
				startInMemorySpan(this.state, { context, localId }, options, callback),
		};
		contextCarriers.set(parent, context);
		return parent;
	}

	counter(name: string, options?: InstrumentOptions): TelemetryCounter {
		return { add: createMeasurementRecorder(this.state, "counter", name, options) };
	}

	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter {
		return { add: createMeasurementRecorder(this.state, "upDownCounter", name, options) };
	}

	histogram(name: string, options?: HistogramOptions): TelemetryHistogram {
		return { record: createMeasurementRecorder(this.state, "histogram", name, options) };
	}

	private storedSpans(): StoredSpan[] {
		return this.state.spans
			.filter((span) => span.settled)
			.map((span) => ({
				id: carrierId(span.context),
				traceId: span.context["pi-memory-trace"],
				...(span.parentContext ? { parentId: carrierId(span.parentContext) } : {}),
				name: span.name,
				startedMs: span.startedMs,
				endedMs: span.endedMs!,
				attributes: copyAttributes(span.attributes),
				events: span.events.map((event) => ({
					name: event.name,
					timeMs: event.timeMs,
					attributes: copyAttributes(event.attributes),
				})),
				links: span.links.map((link) => ({
					traceId: link.context["pi-memory-trace"],
					spanId: carrierId(link.context),
					attributes: copyAttributes(link.attributes),
				})),
				status: copyStatus(span.status),
			}))
			.sort((a, b) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	async getTrace(traceId: string): Promise<StoredTrace | undefined> {
		const spans = this.storedSpans().filter((span) => span.traceId === traceId);
		return spans.length ? { traceId, spans } : undefined;
	}

	async findTraces(query: TraceQuery = {}): Promise<{ traces: readonly StoredTrace[]; cursor?: string }> {
		const limit = query.limit ?? 20;
		const after = query.cursor === undefined ? undefined : (JSON.parse(query.cursor) as [number, string]);
		const grouped = new Map<string, { traceId: string; spans: StoredSpan[] }>();
		for (const span of this.storedSpans()) {
			let trace = grouped.get(span.traceId);
			if (!trace) {
				trace = { traceId: span.traceId, spans: [] };
				grouped.set(span.traceId, trace);
			}
			trace.spans.push(span);
		}
		const matches = [...grouped.values()]
			.filter((trace) => {
				const first = trace.spans[0];
				return (
					(query.name === undefined || first.name === query.name) &&
					(query.startMin === undefined || first.startedMs >= query.startMin) &&
					(query.startMax === undefined || first.startedMs <= query.startMax) &&
					(!after || first.startedMs < after[0] || (first.startedMs === after[0] && trace.traceId > after[1])) &&
					(!query.errors || trace.spans.some((span) => span.status.status === "error")) &&
					(!query.attributes ||
						trace.spans.some((span) =>
							Object.entries(query.attributes!).every(([key, value]) => span.attributes[key] === value),
						))
				);
			})
			.sort(
				(a, b) =>
					b.spans[0].startedMs - a.spans[0].startedMs || (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0),
			);
		const traces = matches.slice(0, limit);
		const last = traces.at(-1)!;
		return {
			traces,
			...(matches.length > limit ? { cursor: JSON.stringify([last.spans[0].startedMs, last.traceId]) } : {}),
		};
	}

	/** Read raw measurements as count-one rows, without changing getMetrics() snapshots. */
	async findMetrics(query: MetricQuery): Promise<readonly StoredMetric[]> {
		return this.state.measurements
			.filter(
				({ intervalMs, measurement }) =>
					measurement.name === query.name &&
					(query.startMin === undefined || intervalMs >= query.startMin) &&
					(query.startMax === undefined || intervalMs <= query.startMax) &&
					Object.entries(query.attributes ?? {}).every(([key, value]) => measurement.attributes[key] === value),
			)
			.map(({ intervalMs, measurement }) => ({
				intervalMs,
				name: measurement.name,
				kind: measurement.kind,
				...(measurement.unit === undefined ? {} : { unit: measurement.unit }),
				attributes: copyAttributes(measurement.attributes),
				count: 1,
				sum: measurement.value,
				min: measurement.value,
				max: measurement.value,
			}));
	}

	/** Returns detached measurements in recording order, without aggregation. */
	getMetrics(): readonly RecordedTelemetryMeasurement[] {
		return this.state.measurements.map(({ measurement }) => ({
			...measurement,
			...(measurement.boundaries === undefined ? {} : { boundaries: [...measurement.boundaries] }),
			attributes: copyAttributes(measurement.attributes),
			context: measurement.context ? { ...measurement.context } : null,
		}));
	}

	/** Returns detached snapshots in span-start order. */
	getSpans(): readonly RecordedTelemetrySpan[] {
		return this.state.spans.map((span) => ({
			id: span.id,
			parentId: span.parentId,
			context: { ...span.context },
			parentContext: span.parentContext ? { ...span.parentContext } : null,
			links: span.links.map((link) => ({
				context: { ...link.context },
				attributes: copyAttributes(link.attributes),
			})),
			name: span.name,
			attributes: copyAttributes(span.attributes),
			events: span.events.map((event) => ({
				name: event.name,
				attributes: copyAttributes(event.attributes),
			})),
			status: copyStatus(span.status),
			settled: span.settled,
			...(span.endSequence === undefined ? {} : { endSequence: span.endSequence }),
		}));
	}
}
