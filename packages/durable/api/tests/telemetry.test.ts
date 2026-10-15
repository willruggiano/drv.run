import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  NOOP_TELEMETRY_CONTEXT,
  type RecordedTelemetryMeasurement,
  type SpanAttributes,
  type TelemetryCarrier,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import {
  createTelemetryAdapterConformance,
  type TelemetryAdapterFixture,
} from "@earendil-works/pi-telemetry/testing";
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  defaultTextMapSetter,
  type Attributes,
  type Context,
  type Meter,
  type MetricOptions,
  type SpanContext,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  TracerProvider,
  BatchSpanProcessor,
  type Span,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { createTelemetry } from "durable-api/telemetry";
import { openHarness } from "./fixtures.ts";

function carrier(context: SpanContext | undefined): TelemetryCarrier | null {
  if (!context) return null;
  const result: TelemetryCarrier = {};
  new W3CTraceContextPropagator().inject(
    trace.setSpanContext(ROOT_CONTEXT, context),
    result,
    defaultTextMapSetter,
  );
  return result;
}

async function conformanceFixture(): Promise<TelemetryAdapterFixture> {
  const spans: Span[] = [];
  const ended = new Map<ReadableSpan, number>();
  const provider = new TracerProvider({
    spanProcessors: [
      {
        onStart(span) {
          spans.push(span);
        },
        onEnd(span) {
          ended.set(span, ended.size);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  const measurements: RecordedTelemetryMeasurement[] = [];
  // Ordered raw measurements are intentionally unavailable from an aggregating SDK.
  // This Meter boundary recorder tests forwarding; the OTLP test below uses the real SDK.
  function record(
    kind: RecordedTelemetryMeasurement["kind"],
    name: string,
    options?: MetricOptions,
  ) {
    const metadata = structuredClone(options ?? {});
    return (value: number, attributes: Attributes = {}, context: Context = ROOT_CONTEXT) => {
      measurements.push({
        kind,
        name,
        value,
        ...(metadata.description === undefined ? {} : { description: metadata.description }),
        ...(metadata.unit === undefined ? {} : { unit: metadata.unit }),
        ...(metadata.advice?.explicitBucketBoundaries === undefined
          ? {}
          : { boundaries: metadata.advice.explicitBucketBoundaries }),
        attributes: structuredClone(attributes) as SpanAttributes,
        context: carrier(trace.getSpanContext(context)),
      });
    };
  }
  const meter = {
    createCounter(name, options) {
      return { add: record("counter", name, options) };
    },
    createUpDownCounter(name, options) {
      return { add: record("upDownCounter", name, options) };
    },
    createHistogram(name, options) {
      return { record: record("histogram", name, options) };
    },
  } satisfies Pick<Meter, "createCounter" | "createUpDownCounter" | "createHistogram">;
  const context = createTelemetry(provider.getTracer("conformance"), meter as Meter);
  return {
    context,
    metrics: context.metrics!,
    propagation: context.propagation!,
    async getMetrics() {
      return measurements;
    },
    async getSpans() {
      return spans.map((span, id) => {
        const parentId = spans.findIndex(
          (candidate) => candidate.spanContext().spanId === span.parentSpanContext?.spanId,
        );
        const errorName = span.attributes["error.type"];
        return {
          id,
          parentId: parentId === -1 ? null : parentId,
          context: carrier(span.spanContext())!,
          parentContext: carrier(span.parentSpanContext),
          links: span.links.map((link) => ({
            context: carrier(link.context)!,
            attributes: (link.attributes ?? {}) as SpanAttributes,
          })),
          name: span.name,
          attributes: span.attributes as SpanAttributes,
          events: span.events.map((event) => ({
            name: event.name,
            attributes: (event.attributes ?? {}) as SpanAttributes,
          })),
          status:
            span.status.code === SpanStatusCode.ERROR
              ? {
                  status: "error" as const,
                  ...(typeof errorName === "string"
                    ? { error: { name: errorName, message: span.status.message! } }
                    : {}),
                }
              : { status: "ok" as const },
          settled: ended.has(span),
          ...(ended.has(span) ? { endSequence: ended.get(span)! } : {}),
        };
      });
    },
    async [Symbol.asyncDispose]() {
      await provider.shutdown();
    },
  };
}

for (const scenario of createTelemetryAdapterConformance(conformanceFixture))
  void test(`telemetry: ${scenario.group}: ${scenario.name}`, () => scenario.run());

void test("inert descendants keep capabilities; all metric defaults and explicit error status map to OTel", async () => {
  await using fixture = await conformanceFixture();
  let settled: TelemetrySpan | undefined;
  await fixture.context.startSpan(
    { name: "defaults", links: [{ context: NOOP_TELEMETRY_CONTEXT }] },
    (span) => {
      settled = span;
      span.addEvent("empty");
      span.setStatus({ status: "error" });
    },
  );
  assert(settled);
  await settled.startSpan({ name: "inert" }, (child) =>
    child.startSpan({ name: "also-inert" }, (nested) => {
      assert.equal(nested.metrics, fixture.metrics);
      assert.equal(nested.propagation, fixture.propagation);
    }),
  );
  fixture.metrics!.counter("default").add(1);
  fixture.metrics!.upDownCounter("described", { unit: "1" }).add(-1, { flag: true });
  fixture.metrics!.histogram("default").record(1, {}, NOOP_TELEMETRY_CONTEXT);
  assert.equal((await fixture.getSpans()).length, 1);
  assert.deepEqual((await fixture.getSpans())[0]?.status, { status: "error" });
  assert.deepEqual(
    (await fixture.getMetrics!()).map((value) => value.name),
    ["default", "described", "default"],
  );
});

void test("real Durable and AI instrumentation exports through SDK batching to local OTLP/HTTP", async (t) => {
  type Attribute = {
    key: string;
    value: { stringValue?: string; intValue?: string; doubleValue?: number };
  };
  type TraceRequest = {
    resourceSpans: {
      resource: { attributes: Attribute[] };
      scopeSpans: {
        spans: {
          name: string;
          traceId: string;
          spanId: string;
          parentSpanId?: string;
          links?: { traceId: string; spanId: string }[];
          attributes: Attribute[];
        }[];
      }[];
    }[];
  };
  type MetricRequest = {
    resourceMetrics: {
      resource: { attributes: Attribute[] };
      scopeMetrics: {
        metrics: {
          name: string;
          sum?: { dataPoints: unknown[] };
          histogram?: { dataPoints: unknown[] };
        }[];
      }[];
    }[];
  };
  const traces: TraceRequest[] = [];
  const metrics: MetricRequest[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.url === "/v1/traces") traces.push(value);
    else {
      assert.equal(request.url, "/v1/metrics");
      metrics.push(value);
    }
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  }).listen(0, "127.0.0.1");
  await once(collector, "listening");
  t.after(() => {
    collector.closeAllConnections();
    collector.close();
  });
  const address = collector.address();
  assert(address && typeof address !== "string");
  const environment = { ...process.env };
  t.after(() => {
    process.env = environment;
  });
  process.env.OTEL_SERVICE_NAME = "durable-api-test";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${address.port}`;
  const resource = resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME! });
  const tracer = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
  });
  const meter = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 60_000,
      }),
    ],
  });
  const telemetry = createTelemetry(tracer.getTracer("durable-api"), meter.getMeter("durable-api"));
  const { harness, root, faux } = await openHarness(t, { telemetry });
  t.after(async () => {
    await harness.close(BACKGROUND_CONTEXT);
    await Promise.all([tracer.shutdown(), meter.shutdown()]);
  });
  faux.setResponses([fauxAssistantMessage("OTLP answer")]);
  const submission = await root.submit(
    { type: "input", content: "OTLP question" },
    BACKGROUND_CONTEXT,
  );
  await submission.wait(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  // Shutdown must flush providers only after Harnesses have settled their final spans/metrics.
  await Promise.all([tracer.shutdown(), meter.shutdown()]);
  const spans = traces.flatMap((request) =>
    request.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
  assert(spans.some((span) => span.name === "pi.durable.submit"));
  assert(spans.some((span) => span.name === "pi.durable.phase"));
  assert(spans.some((span) => span.name === "pi.ai.request"));
  const values = metrics.flatMap((request) =>
    request.resourceMetrics.flatMap((resource) =>
      resource.scopeMetrics.flatMap((scope) => scope.metrics),
    ),
  );
  assert(
    values.some(
      (metric) =>
        metric.name === "pi.durable.phase.duration" && metric.histogram?.dataPoints.length,
    ),
  );
  assert(
    values.some(
      (metric) => metric.name === "pi.ai.request.duration" && metric.histogram?.dataPoints.length,
    ),
  );
  for (const request of traces)
    for (const item of request.resourceSpans)
      assert(
        item.resource.attributes.some(
          (attribute) =>
            attribute.key === "service.name" && attribute.value.stringValue === "durable-api-test",
        ),
      );
});
