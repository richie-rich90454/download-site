import { describe, it, expect } from "vitest";
import * as opentelemetry from "@opentelemetry/api";
import * as tracing from "../../../src/server/telemetry/tracing.js";

describe("NoopTracerProvider", function () {
    it("returns a noop tracer", function () {
        const provider = new tracing.NoopTracerProvider();
        const tracer = provider.getTracer("test");

        expect(tracer).toBeDefined();
    });

    it("starts and ends noop spans", function () {
        const provider = new tracing.NoopTracerProvider();
        const span = provider.startSpan("test-span");

        expect(span).toBeDefined();
        expect(span.spanContext).toBeDefined();
        expect(function () {
            provider.endSpan(span);
        }).not.toThrow();
    });

    it("returns noop span context", function () {
        const provider = new tracing.NoopTracerProvider();
        const span = provider.startSpan("test-span");
        const context = span.spanContext();

        expect(context.traceId).toBe("00000000000000000000000000000000");
        expect(context.spanId).toBe("0000000000000000");
        expect(context.traceFlags).toBe(0);
        expect(context.isRemote).toBe(false);
    });

    it("returns self from noop span mutators", function () {
        const provider = new tracing.NoopTracerProvider();
        const span = provider.startSpan("test-span");

        expect(span.setAttribute("key", "value")).toBe(span);
        expect(span.setAttributes({ key: "value" })).toBe(span);
        expect(span.addEvent("event")).toBe(span);
        expect(span.setStatus({ code: 0 })).toBe(span);
        expect(span.updateName("new-name")).toBe(span);
    });

    it("returns false for isRecording", function () {
        const provider = new tracing.NoopTracerProvider();
        const span = provider.startSpan("test-span");

        expect(span.isRecording()).toBe(false);
    });

    it("does not throw when recording exception", function () {
        const provider = new tracing.NoopTracerProvider();
        const span = provider.startSpan("test-span");

        expect(function () {
            span.recordException(new Error("test"));
        }).not.toThrow();
    });

    it("runs function inside noop active span", function () {
        const provider = new tracing.NoopTracerProvider();
        const tracer = provider.getTracer("test");
        const result = tracer.startActiveSpan("active", function (span) {
            return span;
        });

        expect(result).toBeDefined();
    });

    it("starts a span from tracer", function () {
        const provider = new tracing.NoopTracerProvider();
        const tracer = provider.getTracer("test");
        const span = tracer.startSpan("tracer-span");

        expect(span).toBeDefined();
    });
});

describe("TelemetryService", function () {
    it("uses NoopTracerProvider by default", function () {
        const telemetry = new tracing.TelemetryService();
        const tracer = telemetry.getTracer("test");

        expect(tracer).toBeDefined();
    });

    it("uses custom tracer provider when provided", function () {
        const customProvider: tracing.TracerProvider = {
            getTracer: function (): opentelemetry.Tracer {
                return new tracing.NoopTracerProvider().getTracer("custom");
            },
            startSpan: function (): opentelemetry.Span {
                return new tracing.NoopTracerProvider().startSpan("custom");
            },
            endSpan: function (): void {
                // no-op
            }
        };
        const telemetry = new tracing.TelemetryService(customProvider);
        const tracer = telemetry.getTracer("test");

        expect(tracer).toBeDefined();
    });

    it("starts and ends spans", function () {
        const telemetry = new tracing.TelemetryService();
        const span = telemetry.startSpan("test-span");

        expect(span).toBeDefined();
        expect(function () {
            telemetry.endSpan(span);
        }).not.toThrow();
    });
});
