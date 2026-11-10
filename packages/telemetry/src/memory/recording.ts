import type {
	HistogramOptions,
	SpanAttributes,
	SpanLink,
	SpanOptions,
	SpanStatus,
	TelemetryCarrier,
	TelemetryContext,
	TelemetryMetrics,
	TelemetryPropagation,
	TelemetrySpan,
} from "../context.ts";
import { NOOP_TELEMETRY_CONTEXT } from "../noop.ts";

export interface RecordedTelemetryEvent {
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
}

export interface RecordedTelemetryLink {
	readonly context: Readonly<TelemetryCarrier>;
	readonly attributes: Readonly<SpanAttributes>;
}

export interface RecordedTelemetrySpan {
	readonly id: number;
	/** Local parent ID, or null for roots and parents owned by another recorder. */
	readonly parentId: number | null;
	readonly context: Readonly<TelemetryCarrier>;
	readonly parentContext: Readonly<TelemetryCarrier> | null;
	readonly links: readonly RecordedTelemetryLink[];
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
	readonly events: readonly RecordedTelemetryEvent[];
	readonly status: SpanStatus;
	readonly settled: boolean;
	readonly endSequence?: number;
}

export interface RecordedTelemetryMeasurement {
	readonly kind: "counter" | "upDownCounter" | "histogram";
	readonly name: string;
	readonly description?: string;
	readonly unit?: string;
	readonly boundaries?: readonly number[];
	readonly value: number;
	readonly attributes: Readonly<SpanAttributes>;
	readonly context: Readonly<TelemetryCarrier> | null;
}

interface MutableRecordedTelemetryEvent {
	timeMs: number;
	name: string;
	attributes: SpanAttributes;
}

interface MutableRecordedTelemetrySpan {
	startedMs: number;
	clock: number;
	endedMs?: number;
	id: number;
	parentId: number | null;
	context: TelemetryCarrier;
	parentContext: TelemetryCarrier | null;
	links: RecordedTelemetryLink[];
	name: string;
	attributes: SpanAttributes;
	events: MutableRecordedTelemetryEvent[];
	status: SpanStatus;
	explicitStatus: boolean;
	settled: boolean;
	endSequence?: number;
}

interface InMemoryParent {
	context: TelemetryCarrier;
	localId: number | null;
	span?: MutableRecordedTelemetrySpan;
}

/** The in-memory adapter's carrier keys: its recorder scope, span number and trace. */
export const CARRIER_KEYS = {
	scope: "octocode-memory-scope",
	span: "octocode-memory-span",
	trace: "octocode-memory-trace",
} as const;

export function carrierField(
	carrier: Readonly<TelemetryCarrier> | undefined,
	field: keyof typeof CARRIER_KEYS,
): unknown {
	return carrier?.[CARRIER_KEYS[field]];
}

export function carrierId(carrier: Readonly<TelemetryCarrier>): string {
	return `${carrier[CARRIER_KEYS.scope]}:${carrier[CARRIER_KEYS.span]}`;
}

// Identity survives settlement without exposing backend IDs on the generic context contract.
export const contextCarriers = new WeakMap<TelemetryContext, TelemetryCarrier>();

export interface InMemoryTelemetryState {
	metrics: TelemetryMetrics;
	propagation: TelemetryPropagation;
	scope: string;
	spans: MutableRecordedTelemetrySpan[];
	measurements: { intervalMs: number; measurement: RecordedTelemetryMeasurement }[];
	nextSpanId: number;
	nextEndSequence: number;
}

export function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	return Object.fromEntries(
		Object.entries(attributes ?? {})
			.filter(([, value]) => value !== undefined)
			.map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]),
	);
}

function copyLink(link: SpanLink): RecordedTelemetryLink | undefined {
	const context = contextCarriers.get(link.context);
	return context ? { context: { ...context }, attributes: copyAttributes(link.attributes) } : undefined;
}

/** An error status carrying only the error's name and message, or none when the failure is not described. */
function errorStatus(error: { name: string; message: string } | undefined): SpanStatus {
	return error ? { status: "error", error: { name: error.name, message: error.message } } : { status: "error" };
}

export function copyStatus(status: SpanStatus): SpanStatus {
	return status.status === "ok" ? { status: "ok" } : errorStatus(status.error);
}

function createSpan(
	state: InMemoryTelemetryState,
	parent: InMemoryParent | undefined,
	options: SpanOptions,
): MutableRecordedTelemetrySpan {
	const name = options.name;
	const attributes = copyAttributes(options.attributes);
	const links: RecordedTelemetryLink[] = [];
	for (const link of options.links ?? []) {
		const copy = copyLink(link);
		if (copy) links.push(copy);
	}
	const id = state.nextSpanId++;
	return {
		startedMs: Date.now(),
		clock: performance.now(),
		id,
		parentId: parent?.localId ?? null,
		context: {
			[CARRIER_KEYS.scope]: state.scope,
			[CARRIER_KEYS.span]: String(id),
			[CARRIER_KEYS.trace]: parent?.context[CARRIER_KEYS.trace] ?? `${state.scope}:${id}`,
		},
		parentContext: parent ? { ...parent.context } : null,
		links,
		name,
		attributes,
		events: [],
		status: { status: "ok" },
		explicitStatus: false,
		settled: false,
	};
}

function startInertSpan<T>(
	state: InMemoryTelemetryState,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	return NOOP_TELEMETRY_CONTEXT.startSpan(options, (noop) =>
		callback({
			...noop,
			metrics: state.metrics,
			propagation: state.propagation,
			startSpan: <Result>(
				childOptions: SpanOptions,
				childCallback: (span: TelemetrySpan) => Result | Promise<Result>,
			) => startInertSpan(state, childOptions, childCallback),
		}),
	);
}

export async function startInMemorySpan<T>(
	state: InMemoryTelemetryState,
	parent: InMemoryParent | undefined,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	if (parent?.span?.settled) return startInertSpan(state, options, callback);

	const recordedSpan = createSpan(state, parent, options);
	state.spans.push(recordedSpan);

	const span: TelemetrySpan = {
		metrics: state.metrics,
		propagation: state.propagation,
		startSpan: <Result>(childOptions: SpanOptions, childCallback: (child: TelemetrySpan) => Result | Promise<Result>) =>
			startInMemorySpan(
				state,
				{ context: recordedSpan.context, localId: recordedSpan.id, span: recordedSpan },
				childOptions,
				childCallback,
			),
		addLink(link) {
			if (recordedSpan.settled) return;
			const copy = copyLink(link);
			if (copy) recordedSpan.links.push(copy);
		},
		addEvent(name, attributes) {
			if (recordedSpan.settled) return;
			recordedSpan.events.push({
				name,
				timeMs: performance.now() - recordedSpan.clock,
				attributes: copyAttributes(attributes),
			});
		},
		setAttributes(attributes) {
			if (recordedSpan.settled) return;
			recordedSpan.attributes = { ...recordedSpan.attributes, ...copyAttributes(attributes) };
		},
		setStatus(status) {
			if (recordedSpan.settled) return;
			recordedSpan.status = copyStatus(status);
			recordedSpan.explicitStatus = true;
		},
	};

	contextCarriers.set(span, recordedSpan.context);

	try {
		return await callback(span);
	} catch (error) {
		if (!recordedSpan.explicitStatus) recordedSpan.status = errorStatus(error instanceof Error ? error : undefined);
		throw error;
	} finally {
		recordedSpan.settled = true;
		recordedSpan.endedMs = recordedSpan.startedMs + performance.now() - recordedSpan.clock;
		recordedSpan.endSequence = state.nextEndSequence++;
	}
}

export function createMeasurementRecorder(
	state: InMemoryTelemetryState,
	kind: RecordedTelemetryMeasurement["kind"],
	name: string,
	options?: HistogramOptions,
): (value: number, attributes?: SpanAttributes, context?: TelemetryContext) => void {
	const description = options?.description;
	const unit = options?.unit;
	const boundaries = kind === "histogram" && options?.boundaries !== undefined ? [...options.boundaries] : undefined;
	const metadata = {
		kind,
		name,
		...(description === undefined ? {} : { description }),
		...(unit === undefined ? {} : { unit }),
		...(boundaries === undefined ? {} : { boundaries }),
	};
	return (value, attributes, context) => {
		const carrier = context === undefined ? undefined : contextCarriers.get(context);
		state.measurements.push({
			intervalMs: Math.floor(Date.now() / 10_000) * 10_000,
			measurement: {
				...metadata,
				value,
				attributes: copyAttributes(attributes),
				context: carrier ? { ...carrier } : null,
			},
		});
	};
}
