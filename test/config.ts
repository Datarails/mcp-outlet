import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ANY_STRING, ANY_OBJECT, TestSuiteConfig } from "./types.ts";
import {
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
  baseRpc,
  mockStartResult,
} from "./helpers.ts";

const config: TestSuiteConfig = {
  env: { NODE_ENV: "debug" },
  mocks: {
    connect: { returns: "void" },
    close: { returns: "void" },
    executeMcpCall: { returns: mockStartResult },
  },
  testCases: [
    // Orchestrator-level Methods (End-to-End)
    {
      name: "ping",
      input: { data: { ...initializeReq, method: "ping" } },
      expected: expectedResult(),
    },
    {
      name: "initialize",
      input: { data: initializeReq },
      expected: expectedResult({
        protocolVersion: initializeReq.params.protocolVersion,
        capabilities: ANY_OBJECT,
        serverInfo: {
          name: "mock-mcp-server",
          version: "1.0.0",
        },
        instructions: "Mock MCP server instructions",
      }),
    },
    {
      name: "logging/setLevel",
      input: {
        data: {
          ...initializeReq,
          method: "logging/setLevel",
          params: { ...initializeReq.params, level: "info" },
        },
      },
      expected: expectedResult({ _meta: { traceLevel: "info" } }),
    },
    {
      name: "notifications/initialized returns undefined",
      input: {
        data: {
          ...initializeReq,
          method: "notifications/initialized",
          id: undefined, // notification
        },
      },
      expected: undefined,
    },

    // MCP Server-level Methods (End-to-End)
    {
      name: "prompts/get returns prompt object",
      mocks: {
        executeMcpCall: { returns: mockPromptResult },
      },
      input: {
        data: getPromptParams,
      },
      mockCalls: [
        {
          mock: "executeMcpCall",
          calledWith: [getPromptParams, ANY_OBJECT],
        },
      ],
      expected: expectedResult(mockPromptResult),
    },
    {
      name: "prompts/list returns prompts list",
      mocks: { executeMcpCall: { returns: mockPromptsResult } },
      input: {
        data: listPromptsParams,
      },
      mockCalls: [
        {
          mock: "executeMcpCall",
          calledWith: [listPromptsParams, ANY_OBJECT],
        },
      ],
      expected: expectedResult(mockPromptsResult),
    },

    {
      name: "resources/list returns resources",
      mocks: { executeMcpCall: { returns: mockResourcesResult } },
      input: { data: { ...mockRequest, method: "resources/list" } },
      mockCalls: [
        {
          mock: "executeMcpCall",
          calledWith: [
            { ...mockRequest, method: "resources/list" },
            ANY_OBJECT,
          ],
        },
      ],
      expected: expectedResult(mockResourcesResult),
    },

    {
      name: "resources/templates/list returns templates",
      mocks: {
        executeMcpCall: { returns: mockTemplatesResult },
      },
      input: {
        data: {
          ...mockRequest,
          method: "resources/templates/list",
        },
      },
      mockCalls: [
        {
          mock: "executeMcpCall",
          calledWith: [
            { ...mockRequest, method: "resources/templates/list" },
            ANY_OBJECT,
          ],
        },
      ],
      expected: expectedResult(mockTemplatesResult),
    },

    {
      name: "resources/read returns resource contents",
      mocks: { executeMcpCall: { returns: mockResourceResult } },
      input: {
        data: {
          ...mockRequest,
          method: "resources/read",
          params: { ...mockRequest.params, uri: "file://test.txt" },
        },
      },
      mockCalls: [
        {
          mock: "executeMcpCall",
          calledWith: [
            {
              ...mockRequest,
              method: "resources/read",
              params: { ...mockRequest.params, uri: "file://test.txt" },
            },
            ANY_OBJECT,
          ],
        },
      ],
      expected: expectedResult(mockResourceResult),
    },

    {
      name: "tools/call returns tool result",
      mocks: { executeMcpCall: { returns: mockToolResult } },
      input: {
        data: {
          ...mockRequest,
          method: "tools/call",
          params: { ...mockRequest.params, name: "test-tool", arguments: {} },
        },
      },
      mockCalls: [
        {
          mock: "executeMcpCall",
          calledWith: [
            {
              ...mockRequest,
              method: "tools/call",
              params: {
                ...mockRequest.params,
                name: "test-tool",
                arguments: {},
              },
            },
            ANY_OBJECT,
          ],
        },
      ],
      expected: expectedResult(mockToolResult),
    },
    {
      name: "tools/list returns tools list",
      mocks: { executeMcpCall: { returns: mockToolsResult } },
      input: { data: { ...mockRequest, method: "tools/list" } },
      mockCalls: [
        {
          mock: "executeMcpCall",
          calledWith: [{ ...mockRequest, method: "tools/list" }, ANY_OBJECT],
        },
      ],
      expected: expectedResult(mockToolsResult),
    },

    // Error Handling (End-to-End)
    {
      name: "method not found",
      input: { data: { ...mockRequest, method: "unknown/method" } },
      expected: expectedError(
        ErrorCode.MethodNotFound,
        "Rpc supporting only",
        undefined,
        true
      ),
    },
    {
      name: "invalid request (no method)",
      input: { data: { jsonrpc: undefined, id: "req-123" } }, // bare minimum
      expected: expectedError(
        ErrorCode.InvalidRequest,
        "Request _meta must be including correct server configuration",
        ANY_STRING,
        undefined,
        undefined,
        { jsonrpc: undefined, id: "req-123" }
      ),
    },
    {
      name: "MCP client creation failure",
      mocks: {
        executeMcpCall: {
          throws: { message: "Failed to create MCP client" },
        },
      },
      input: { data: { ...mockRequest, method: "prompts/list" } },
      expected: expectedError(
        ErrorCode.InternalError,
        "Failed to create MCP client",
        undefined,
        true
      ),
    },
    {
      name: "MCP method execution failure",
      mocks: {
        executeMcpCall: { throws: { message: "MCP server error" } },
      },
      input: {
        data: {
          ...mockRequest,
          method: "prompts/get",
          params: { ...mockRequest.params, name: "test-prompt" },
        },
      },
      expected: expectedError(
        ErrorCode.InternalError,
        "MCP server error",
        undefined,
        true
      ),
    },
    {
      name: "invalid server configuration",
      input: {
        data: {
          ...mockRequest,
          method: "prompts/list",
          params: { _meta: { server: {} } }, // broken config
        },
      },
      expected: expectedError(
        ErrorCode.InvalidRequest,
        "Request _meta must be including correct server configuration",
        ANY_STRING
      ),
    },

    // JSON-RPC Notifications (End-to-End)
    {
      name: "notification/initialized → undefined",
      input: {
        data: {
          ...mockRequest,
          id: undefined,
          method: "notifications/initialized",
          params: { _meta: { server: mockServerConfiguration } },
        },
      },
      expected: undefined,
    },
    {
      name: "unknown notification → error",
      input: {
        data: {
          jsonrpc: "2.0",
          method: "unknown/notification",
          params: { _meta: { server: mockServerConfiguration } },
        },
      },
      expected: expectedError(
        ErrorCode.MethodNotFound,
        "Rpc supporting only",
        undefined,
        true,
        undefined,
        baseRpc
      ),
    },

    // Server Configuration Variations (End-to-End)
    {
      name: "stdio server config",
      mocks: { executeMcpCall: { returns: mockListPromptResult } },
      input: {
        data: {
          ...mockRequest,
          method: "prompts/list",
          params: {
            ...mockRequest.params,
            _meta: { server: stdioConfig },
          },
        },
      },
      mockCalls: [
        {
          mock: "executeMcpCall",
          calledWith: [
            {
              ...mockRequest,
              method: "prompts/list",
              params: { _meta: { server: stdioConfig } },
            },
            ANY_OBJECT,
          ],
        },
      ],
      expected: expectedResult(
        mockListPromptResult,
        undefined,
        undefined,
        stdioConfig
      ),
    },
    {
      name: "sse server config",
      mocks: { executeMcpCall: { returns: sseResources } },
      input: {
        data: {
          ...mockRequest,
          method: "resources/list",
          params: { _meta: { server: sseConfig } },
        },
      },
      mockCalls: [
        {
          mock: "executeMcpCall",
          notCalled: true,
        },
      ],
      expected: expectedError(
        ErrorCode.InvalidRequest,
        "Request _meta must be including correct server configuration",
        ANY_STRING
      ),
    },

    // Tracing Integration (End-to-End)
    // This cant be test and need smoke test
    // {
    //   name: "tracing captures console logs",
    //   mocks: {
    //     executeMcpCall: {
    //       implementation: () => {
    //         console.log("MCP server log message");
    //         console.warn("MCP server warning");
    //         console.error("MCP server error");
    //         return { tools: [] };
    //       },
    //     },
    //   },
    //   input: { data: { ...mockRequest, method: "tools/list" } },
    //   expected: expectedResult(
    //     { tools: [] },
    //     generateTrace([
    //       { seq: "inputValidation", parentSeq: null },
    //       { seq: "connectToServer", parentSeq: null },
    //       {
    //         seq: "executeMcpCall",
    //         parentSeq: null,
    //         data: {
    //           method: "tools/list",
    //           childTrace: [],
    //           logs: [
    //             STRING_CONTAINING("[LOG] MCP server log message"),
    //             STRING_CONTAINING("[WARN] MCP server warning"),
    //             STRING_CONTAINING("[ERROR] MCP server error"),
    //           ],
    //         },
    //         isValid: false,
    //       },
    //     ])
    //   ),
    // },
    {
      name: "Success, no MCP call - Outlet method",
      input: { data: { ...initializeReq, method: "ping" } },
      expected: expectedResult(
        {},
        generateTrace([
          { seq: "inputValidation", parentSeq: null },
          {
            seq: "outletHandler",
            parentSeq: null,
          },
        ])
      ),
    },
    {
      name: "Success, MCP call - basic trace with mcpCall",
      mocks: { executeMcpCall: { returns: { tools: [] } } },
      input: { data: { ...mockRequest, method: "tools/list" } },
      expected: expectedResult(
        { tools: [] },
        generateTrace([
          { seq: "inputValidation", parentSeq: null },
          { seq: "connectToServer", parentSeq: null },
          {
            seq: "executeMcpCall",
            parentSeq: null,
            data: { method: "tools/list" },
          },
        ])
      ),
    },
    {
      name: "Support 1.0.0",
      input: {
        data: {
          jsonrpc: "1.0",
          id: "req-123",
          method: "ping",
          params: { _meta: { server: mockServerConfiguration } },
        }, // invalid jsonrpc version
      },
      expected: expectedResult({}, ANY_OBJECT, {
        jsonrpc: "1.0",
        id: "req-123",
      }),
    },

    // Error Scenarios
    {
      name: "Error at rpc.handler - method not found",
      input: { data: { ...mockRequest, method: "unknown/method" } },
      expected: expectedError(
        ErrorCode.MethodNotFound,
        "Rpc supporting only",
        undefined,
        true,
        generateTrace([
          {
            seq: "inputValidation",
            parentSeq: null,
            status: "error",
          },
        ])
      ),
    },
    {
      name: "Error at *.input - invalid server configuration",
      input: {
        data: {
          ...mockRequest,
          method: "prompts/list",
          params: { _meta: { server: {} } }, // invalid config
        },
      },
      expected: expectedError(
        ErrorCode.InvalidRequest,
        "Request _meta must be including correct server configuration",
        ANY_STRING,
        false,
        generateTrace([
          { seq: "inputValidation", parentSeq: null, status: "error" },
        ])
      ),
    },
    {
      name: "Error at mcpCall - MCP server communication failure",
      mocks: {
        connect: {
          throws: { message: "Failed to create MCP client" },
        },
      },
      input: {
        data: {
          ...mockRequest,
          method: "prompts/get",
          params: { ...mockRequest.params, name: "test" },
        },
      },
      expected: expectedError(
        ErrorCode.InternalError,
        "Failed to create MCP client",
        undefined,
        true,
        generateTrace([
          { seq: "inputValidation", parentSeq: null },
          {
            seq: "connectToServer",
            parentSeq: null,
            status: "error",
          },
        ])
      ),
    },
  ],
};

export default config;
