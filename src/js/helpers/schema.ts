import { z } from "zod";
import { Stream } from "node:stream";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

// Define the IOType enum values
const IOTypeSchema = z.union([
  z.literal("pipe"),
  z.literal("inherit"),
  z.literal("ignore"),
  z.instanceof(Stream),
  z.number(),
]);

const McpServerConfigurationSchema = z
  .object({
    protocolVersion: z
      .enum(SUPPORTED_PROTOCOL_VERSIONS as [string, ...string[]])
      .default(LATEST_PROTOCOL_VERSION)
      .describe("Protocol version"),
    jsonrpc: z.literal("2.0").default("2.0").describe("JSON-RPC version"),
    type: z.enum(["stdio"]).default("stdio"),
    command: z.string().describe("Command to execute (stdio only)"),
    args: z
      .array(z.string())
      .optional()
      .describe("Command arguments (stdio only)"),
    cwd: z.string().optional().describe("Working directory (stdio only)"),
    stderr: z
      .union([IOTypeSchema, z.instanceof(Stream), z.number()])
      .optional()
      .describe("How to handle stderr of the child process (stdio only)"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables"),
    version: z.string().optional().describe("Version of the MCP server"),
  })
  .describe("Detected MCP server with analyzed configuration");

const CustomRequestMetaSchema = z
  .object({
    server: McpServerConfigurationSchema,
  })
  .passthrough();

const TraceSpanSchema = z.object({
  seq: z
    .string()
    .describe("Sequential identifier or name of the span operation"),
  parentSeq: z
    .string()
    .nullable()
    .describe("Sequential identifier of the parent span, null for root spans"),
  startTime: z
    .number()
    .describe("Start timestamp in milliseconds since Unix epoch"),
  duration: z
    .number()
    .optional()
    .describe("Duration of the span in milliseconds"),
  status: z
    .enum(["running", "success", "error"])
    .describe("Current status of the span execution"),
  error: z.string().optional().describe("Error message if the span failed"),
  data: z
    .record(z.string(), z.any())
    .optional()
    .describe("Additional custom data attached to the span"),
  isValid: z
    .boolean()
    .describe("Whether the span data is valid according to schema"),
});

const TraceSchema = z.object({
  traceId: z.string().describe("Unique identifier for the entire trace"),
  startTime: z.date().describe("Start time of the trace as a Date object"),
  endTime: z
    .date()
    .optional()
    .describe("End time of the trace as a Date object"),
  data: z
    .record(z.string(), z.any())
    .optional()
    .describe("Additional custom data attached to the trace"),
  spans: z
    .array(TraceSpanSchema)
    .describe("Array of all spans that occurred during this trace"),
  isValid: z
    .boolean()
    .describe("Whether the trace data is valid according to schema"),
});

const CustomErrorResponseSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.record(z.any()).optional(),
});

export {
  McpServerConfigurationSchema,
  CustomRequestMetaSchema,
  TraceSpanSchema,
  TraceSchema,
  CustomErrorResponseSchema,
};

type McpServerConfiguration = z.infer<typeof McpServerConfigurationSchema>;
type CustomRequestMeta = z.infer<typeof CustomRequestMetaSchema>;
type TraceSpan = z.infer<typeof TraceSpanSchema>;
type Trace = z.infer<typeof TraceSchema>;
type CustomErrorResponse = z.infer<typeof CustomErrorResponseSchema>;

export type {
  McpServerConfiguration,
  CustomRequestMeta,
  TraceSpan,
  Trace,
  CustomErrorResponse,
};
