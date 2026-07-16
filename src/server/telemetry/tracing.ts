import * as opentelemetry from "@opentelemetry/api";

export interface TracerProvider {
    getTracer(name: string): opentelemetry.Tracer;
    startSpan(name: string, parent?: opentelemetry.Span): opentelemetry.Span;
    endSpan(span: opentelemetry.Span): void;
}

class NoopSpan {
    spanContext(): opentelemetry.SpanContext {
        return {
            traceId: "00000000000000000000000000000000",
            spanId: "0000000000000000",
            traceFlags: 0,
            isRemote: false
        };
    }

    setAttribute(): unknown {
        return this;
    }

    setAttributes(): unknown {
        return this;
    }

    addEvent(): unknown {
        return this;
    }

    setStatus(): unknown {
        return this;
    }

    updateName(): unknown {
        return this;
    }

    end(): void {
        // no-op
    }

    isRecording(): boolean {
        return false;
    }

    recordException(): void {
        // no-op
    }
}

class NoopTracer {
    startSpan(): unknown {
        return new NoopSpan();
    }

    startActiveSpan(name: string, fn: unknown): unknown {
        const castFn = fn as (span: unknown) => unknown;
        return castFn(new NoopSpan());
    }
}

export class NoopTracerProvider implements TracerProvider {
    private readonly tracer: opentelemetry.Tracer;

    constructor() {
        this.tracer = new NoopTracer() as unknown as opentelemetry.Tracer;
    }

    getTracer(): opentelemetry.Tracer {
        return this.tracer;
    }

    startSpan(): opentelemetry.Span {
        return new NoopSpan() as unknown as opentelemetry.Span;
    }

    endSpan(span: opentelemetry.Span): void {
        span.end();
    }
}

export class TelemetryService {
    private readonly provider: TracerProvider;

    constructor(provider?: TracerProvider) {
        if (provider !== undefined) {
            this.provider = provider;
        } else {
            this.provider = new NoopTracerProvider();
        }
    }

    getTracer(name: string): opentelemetry.Tracer {
        return this.provider.getTracer(name);
    }

    startSpan(name: string, parent?: opentelemetry.Span): opentelemetry.Span {
        return this.provider.startSpan(name, parent);
    }

    endSpan(span: opentelemetry.Span): void {
        this.provider.endSpan(span);
    }
}
