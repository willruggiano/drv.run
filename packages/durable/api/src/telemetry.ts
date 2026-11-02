import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Attributes,
  type Context,
  type Link,
  type Meter,
  type Tracer,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  NOOP_TELEMETRY_CONTEXT,
  type SpanAttributes,
  type SpanOptions,
  type SpanLink,
  type SpanStatus,
  type TelemetryCarrier,
  type TelemetryContext,
  type TelemetryMetrics,
  type TelemetryPropagation,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";

function attributes(values: SpanAttributes = {}): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) result[key] = typeof value === "object" ? value.slice() : value;
  }
  return result;
}

/** Bind explicit Pi contexts to deployment-owned OTel instruments, without globals. */
export function createTelemetry(tracer: Tracer, meter: Meter): TelemetryContext {
  const contexts = new WeakMap<TelemetryContext, Context>();
  const propagator = new W3CTraceContextPropagator();
  const parent = (context: TelemetryContext | undefined) =>
    context === undefined ? ROOT_CONTEXT : (contexts.get(context) ?? ROOT_CONTEXT);
  const propagation: TelemetryPropagation = {
    inject(context) {
      const carrier: TelemetryCarrier = {};
      propagator.inject(parent(context), carrier, defaultTextMapSetter);
      return Object.keys(carrier).length ? carrier : undefined;
    },
    extract(carrier) {
      return contextual(propagator.extract(ROOT_CONTEXT, carrier ?? {}, defaultTextMapGetter));
    },
  };
  const metrics: TelemetryMetrics = {
    counter(name, options) {
      const instrument = meter.createCounter(name, { ...options });
      return { add: (value, values) => instrument.add(value, attributes(values), ROOT_CONTEXT) };
    },
    upDownCounter(name, options) {
      const instrument = meter.createUpDownCounter(name, { ...options });
      return { add: (value, values) => instrument.add(value, attributes(values), ROOT_CONTEXT) };
    },
    histogram(name, options) {
      const { boundaries, ...metadata } = options ?? {};
      const instrument = meter.createHistogram(name, {
        ...metadata,
        ...(boundaries === undefined
          ? {}
          : { advice: { explicitBucketBoundaries: [...boundaries] } }),
      });
      return {
        record: (value, values, context) =>
          instrument.record(value, attributes(values), parent(context)),
      };
    },
  };
  const capabilities = { metrics, propagation };
  const inert: TelemetryContext["startSpan"] = (options, callback) =>
    NOOP_TELEMETRY_CONTEXT.startSpan(options, (span) =>
      callback({ ...span, ...capabilities, startSpan: inert }),
    );

  function link(value: SpanLink): Link[] {
    const context = trace.getSpanContext(parent(value.context));
    return context ? [{ context, attributes: attributes(value.attributes) }] : [];
  }

  function contextual(context: Context): TelemetryContext {
    const result: TelemetryContext = {
      ...capabilities,
      startSpan<T>(
        options: SpanOptions,
        callback: (span: TelemetrySpan) => T | Promise<T>,
      ): Promise<T> {
        const span = tracer.startSpan(
          options.name,
          {
            attributes: attributes(options.attributes),
            ...(options.links === undefined ? {} : { links: options.links.flatMap(link) }),
          },
          context,
        );
        const childContext = trace.setSpan(context, span);
        let settled = false;
        let status: SpanStatus | undefined;
        const child: TelemetrySpan = {
          ...capabilities,
          startSpan: (options, callback) =>
            settled
              ? inert(options, callback)
              : contextual(childContext).startSpan(options, callback),
          setAttributes(values) {
            if (!settled) span.setAttributes(attributes(values));
          },
          addEvent(name, values) {
            if (!settled) span.addEvent(name, attributes(values));
          },
          addLink(value) {
            if (!settled) span.addLinks(link(value));
          },
          setStatus(value) {
            if (!settled) status = structuredClone(value);
          },
        };
        contexts.set(child, childContext);
        return new Promise<T>((resolve) => resolve(callback(child)))
          .catch((error: unknown) => {
            status ??=
              error instanceof Error
                ? { status: "error", error: { name: error.name, message: error.message } }
                : { status: "error" };
            throw error;
          })
          .finally(() => {
            settled = true;
            if (status?.status === "error") {
              if (status.error) span.setAttribute("error.type", status.error.name);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                ...(status.error === undefined ? {} : { message: status.error.message }),
              });
            } else span.setStatus({ code: SpanStatusCode.OK });
            span.end();
          });
      },
    };
    contexts.set(result, context);
    return result;
  }
  return contextual(ROOT_CONTEXT);
}
