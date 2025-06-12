import { TraceSpan, Trace, TraceSchema } from "./schema.ts";

export class Tracer {
  private spans: TraceSpan[] = [];
  private traceId: string;
  private startTime: Date;
  private endTime?: Date;
  private currentParent: string | null = null;
  private traceAdditionalData?: Record<string, any>;

  constructor(
    traceId: string,
    parent?: string,
    additionalData?: Record<string, any>
  ) {
    this.traceId = traceId;
    this.startTime = new Date();
    this.currentParent = parent || null;
    this.traceAdditionalData = additionalData;
  }

  recordSpan(
    name: string,
    parentSeq?: string,
    additionalData?: Record<string, any>
  ): TraceSpan {
    // End previous span if exists
    if (this.spans.length > 0) {
      const lastSpan = this.spans[this.spans.length - 1];
      if (lastSpan.status === "running") {
        this.endPreviousSpan(lastSpan, false);
      }
    }

    const span: TraceSpan = {
      seq: name,
      parentSeq: parentSeq || this.currentParent,
      startTime: Date.now(),
      status: "running",
      data: additionalData,
      isValid: true,
    };

    this.spans.push(span);
    return span;
  }

  mergeChildTrace(
    baseSeq: string,
    parentSeq: string,
    isSuccess: boolean,
    childTrace: Trace | TraceSpan[] | any,
    additionalData: Record<string, any> = {}
  ) {
    const status = isSuccess ? "success" : "error";
    try {
      const traceValidation = TraceSchema.safeParse(childTrace);
      if (traceValidation.success) {
        const trace = traceValidation.data;

        trace.spans.forEach((span) => {
          this.spans.push({
            ...span,
            status: span?.status || status,
            seq: `${baseSeq}.${span.seq}`, // Prefix with parent
            parentSeq: span.parentSeq || parentSeq,
            isValid: true,
          });
        });

        // Merge trace additional data
        if (trace.data) {
          this.traceAdditionalData = {
            ...additionalData,
            ...this.traceAdditionalData,
            childTraces: [
              ...(this.traceAdditionalData?.childTraces || []),
              trace.data,
            ],
          };
        }
      } else {
        // Add invalid trace spans with prefixed names
        if (childTrace?.spans && Array.isArray(childTrace.spans)) {
          childTrace.spans.forEach((spanData: any) => {
            this.spans.push({
              seq: `${baseSeq}.${spanData?.seq || "unknown_span"}`,
              parentSeq: spanData?.parentSeq || parentSeq,
              startTime: spanData?.startTime || Date.now(),
              duration: spanData?.duration,
              status: spanData?.status || status,
              error: spanData?.error,
              data: {
                ...additionalData,
                ...(spanData ? { spanData: spanData?.data } : {}),
              },
              isValid: false,
            });
          });
        } else {
          // Fallback: create a single span for the invalid trace
          this.spans.push({
            seq: `${baseSeq}.${childTrace?.traceId || "unknown_span"}`,
            parentSeq: parentSeq,
            startTime: Date.now(),
            status,
            duration: 0,
            data: {
              ...additionalData,
              ...(childTrace ? { childTrace: childTrace } : {}),
            },
            isValid: false,
          });
        }
      }
    } catch (error) {
      // Fallback for any parsing errors
      this.spans.push({
        seq: `${baseSeq}.${
          childTrace?.seq || childTrace?.traceId || "parse_error"
        }`,
        parentSeq: parentSeq,
        startTime: Date.now(),
        status: status,
        error: error instanceof Error ? error.message : "Unknown merge error",
        duration: 0,
        data: {
          ...additionalData,
          ...(childTrace ? { childTrace: childTrace } : {}),
        },
        isValid: false,
      });
    }
  }

  private endPreviousSpan(span: TraceSpan, isError: boolean) {
    const endTime = Date.now();
    span.duration = endTime - span.startTime;
    span.status = isError ? "error" : "success";
  }

  private end() {
    if (!this.endTime) {
      this.endTime = new Date();
    }
  }

  getTrace(lastSpanSuccess: boolean = true): Trace {
    for (const span of this.spans) {
      if (span.status === "running") {
        this.endPreviousSpan(span, !lastSpanSuccess);
      }
    }

    const outputSpans = this.spans.map((span) => ({
      seq: span.seq,
      duration: span.duration,
      status: span.status,
      startTime: span.startTime,
      parentSeq: span.parentSeq,
      error: span.error,
      data: span.data,
      isValid: span.isValid,
    }));

    this.end();

    return {
      traceId: this.traceId,
      startTime: this.startTime,
      endTime: this.endTime,
      data: this.traceAdditionalData,
      spans: outputSpans,
      isValid: true,
    };
  }
}
