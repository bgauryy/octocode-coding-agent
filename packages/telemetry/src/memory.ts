import type {
	HistogramOptions,
	InstrumentOptions,
	SpanOptions,
	TelemetryCarrier,
	TelemetryContext,
	TelemetryCounter,
	TelemetryHistogram,
	TelemetryMetrics,
	TelemetryPropagation,
	TelemetrySpan,
	TelemetryUpDownCounter,
} from "./context.ts";
import {
	CARRIER_KEYS,
	carrierField,
	contextCarriers,
	copyAttributes,
	copyStatus,
	createMeasurementRecorder,
	type InMemoryTelemetryState,
	type RecordedTelemetryMeasurement,
	type RecordedTelemetrySpan,
	startInMemorySpan,
} from "./memory/recording.ts";

/**
 * Backend-neutral reference implementation that records spans in process memory.
 * Create a fresh instance to isolate tests or independent recording scopes.
 */
export class InMemoryTelemetryContext implements TelemetryContext, TelemetryPropagation, TelemetryMetrics {
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
		const scope = carrierField(carrier, "scope");
		const span = carrierField(carrier, "span");
		const traceId = carrierField(carrier, "trace");
		if (typeof scope !== "string" || typeof span !== "string" || typeof traceId !== "string") return this;
		const context = { [CARRIER_KEYS.scope]: scope, [CARRIER_KEYS.span]: span, [CARRIER_KEYS.trace]: traceId };
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

	/** Returns detached measurements in recording order, without aggregation. */
	getMetrics(): readonly RecordedTelemetryMeasurement[] {
		return this.state.measurements.map((measurement) => ({
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
