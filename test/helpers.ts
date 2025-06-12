import {
  ANY_STRING,
  ANY_DATE,
  ANY_NUMBER,
  ANY_OBJECT,
  STRING_CONTAINING,
} from "./types.ts";

function generateTrace(specs: any) {
  const spanSpecs = Array.isArray(specs) ? specs : specs.spans;
  const traceAdditionalData = Array.isArray(specs) ? undefined : specs.data;

  return {
    traceId: ANY_STRING,
    startTime: ANY_DATE,
    endTime: ANY_DATE,
    data: traceAdditionalData,
    spans: spanSpecs.map(
      ({
        seq,
        parentSeq,
        status = "success",
        error,
        data,
        isValid = true,
      }) => ({
        seq,
        duration: ANY_NUMBER,
        status,
        startTime: ANY_NUMBER,
        parentSeq,
        isValid,
        data,
        error,
      })
    ),
    isValid: true,
  };
}

const mockServerConfiguration = {
  type: "stdio" as const,
  command: "uv",
  args: ["pip", "show", "mcp-yahoo-finance"],
  cwd: ".",
  jsonrpc: "2.0",
  protocolVersion: "2025-03-26",
};

const BASE = { jsonrpc: "2.0" } as const;
const BASE_WITH_ID = { ...BASE, id: "req-123" } as const;

function expectedResult(
  partialResult: Record<string, any> = {},
  trace: any = ANY_OBJECT,
  base: any = BASE_WITH_ID,
  server: any = mockServerConfiguration
) {
  return {
    ...base,
    result: {
      ...partialResult,
      _meta: {
        ...partialResult?._meta,
        server,
        trace,
      },
    },
  };
}

function expectedError(
  code: number,
  messageLike: string | RegExp,
  reasonLike?: any,
  includeServer = false,
  trace: any = ANY_OBJECT,
  base: any = BASE_WITH_ID
) {
  return {
    ...base,
    error: {
      code,
      message: STRING_CONTAINING(messageLike as string),
      data: {
        ...(reasonLike ? { reason: reasonLike } : {}),
        _meta: {
          ...(includeServer ? { server: mockServerConfiguration } : {}),
          trace,
        },
      },
    },
  };
}
const baseRpc = {
  jsonrpc: "2.0",
};

const baseRpcWithId = {
  ...baseRpc,
  id: "req-123",
};

const mockRequest = {
  ...baseRpcWithId,
  params: {
    _meta: { server: mockServerConfiguration },
  },
};
const initializeReq = {
  ...mockRequest,
  method: "initialize",
  params: {
    _meta: mockRequest.params._meta,
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
    instructions: "test-instructions",
  },
};
const mockPromptResult = {
  description: "Test prompt",
  messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
};
const getPromptParams = {
  ...mockRequest,
  method: "prompts/get",
  params: {
    ...mockRequest.params,
    name: "test-prompt",
    arguments: { key: "value" },
  },
};
const mockPromptsResult = {
  prompts: [
    { name: "prompt1", description: "First prompt" },
    { name: "prompt2", description: "Second prompt" },
  ],
};
const listPromptsParams = {
  ...mockRequest,
  method: "prompts/list",
  params: {
    ...mockRequest.params,
    cursor: "next-page",
  },
};

const mockResourcesResult = {
  resources: [
    { uri: "file://test1.txt", name: "Test File 1" },
    { uri: "file://test2.txt", name: "Test File 2" },
  ],
};

const mockTemplatesResult = {
  resourceTemplates: [
    { uriTemplate: "file://docs/{name}.md", name: "Document Template" },
  ],
};

const mockResourceResult = {
  contents: [
    {
      uri: "file://test.txt",
      text: "File content",
      mimeType: "text/plain",
    },
  ],
};

const mockToolResult = {
  content: [{ type: "text", text: "Tool execution result" }],
  isError: false,
};

const mockToolsResult = {
  tools: [
    {
      name: "tool1",
      description: "First tool",
      inputSchema: { type: "object" },
    },
    {
      name: "tool2",
      description: "Second tool",
      inputSchema: { type: "object" },
    },
  ],
};

const stdioConfig = {
  type: "stdio" as const,
  command: "node",
  args: ["mcp-server.js"],
  cwd: "/app",
  env: { NODE_ENV: "production" },
  jsonrpc: "2.0",
  protocolVersion: "2025-03-26",
};

const sseConfig = {
  type: "sse" as const,
  url: "http://localhost:3000/sse",
  env: { API_KEY: "test-key" },
};

// Server-variation happy-path payloads
const mockListPromptResult = {
  prompts: [{ name: "test", description: "test" }],
};
const sseResources = {
  resources: [{ uri: "test://resource", name: "Test" }],
};

const mockStartResult = {
  protocolVersion: initializeReq.params.protocolVersion,
  capabilities: {},
  serverInfo: {
    name: "mock-mcp-server",
    version: "1.0.0",
  },
  instructions: "Mock MCP server instructions",
};

export {
  mockStartResult,
  generateTrace,
  expectedResult,
  expectedError,
  mockRequest,
  initializeReq,
  mockPromptResult,
  getPromptParams,
  mockPromptsResult,
  listPromptsParams,
  mockResourcesResult,
  mockTemplatesResult,
  mockResourceResult,
  mockToolResult,
  mockToolsResult,
  stdioConfig,
  sseConfig,
  mockListPromptResult,
  sseResources,
  mockServerConfiguration,
  BASE as baseRpc,
};
