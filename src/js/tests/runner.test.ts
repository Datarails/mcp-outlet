import { jest } from "@jest/globals";
import { Tracer } from "../helpers/tracer.ts";
import { rpc } from "../handlers/rpc.ts";
import { mockMcpCallHandler, resetMocks } from "./setup.ts";
import { readFileSync } from "fs";
import { resolve } from "path";

const configPath = process.env.TEST_CONFIG_PATH;
if (!configPath) {
  throw new Error("TEST_CONFIG_PATH environment variable must be set");
}
const fullPath = resolve(process.cwd(), configPath);
const testConfig = JSON.parse(readFileSync(fullPath, "utf8"));
async function executeTest(input: any) {
  const tracer = new Tracer("test-trace");
  return rpc.execute(input, { tracer });
}

// TODO - do it more generic or one source of truth
/** Convert placeholder symbols inside `value` into real Jest matchers. */
function toMatcher(value: any): any {
  if (value && value.__kind === "ANY_STRING") return expect.any(String);
  if (value && value.__kind === "ANY_NUMBER") return expect.any(Number);
  if (value && value.__kind === "ANY_DATE") return expect.any(Date);
  if (value && value.__kind === "ANY_OBJECT") return expect.any(Object);
  if (value && value.__kind === "ANYTHING") return expect.anything();

  if (value && value.__kind === "STRING_CONTAINING") {
    return expect.stringContaining(value.substring);
  }

  if (value && value.__kind === "OBJECT_CONTAINING") {
    return expect.objectContaining(toMatcher(value.partial));
  }
  if (value && value.__kind === "NOT_OBJECT_CONTAINING") {
    return expect.not.objectContaining(toMatcher(value.partial));
  }

  if (Array.isArray(value)) {
    return value.map(toMatcher);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toMatcher(v)])
    );
  }

  return value;
}

function setupMocksForTest(testMocks: any = {}) {
  jest.clearAllMocks();
  resetMocks();
  const merged = { ...(testConfig.mocks ?? {}), ...testMocks };

  Object.entries(merged).forEach(([method, behaviour]: [string, any]) => {
    const fn = mockMcpCallHandler[method] as jest.Mock;

    if (!jest.isMockFunction(fn)) return;
    const { implementation, throws, returns } = behaviour;

    if (implementation) {
      fn.mockImplementation(implementation as never);
    } else if (throws) {
      fn.mockRejectedValue(throws as never);
    } else if (returns === "void") {
      fn.mockResolvedValue(void 0 as never);
    } else if (returns !== undefined) {
      fn.mockResolvedValue(returns as never);
    }
  });
}

function verifyMockCalls(checks: any[]) {
  for (const check of checks) {
    const fn: jest.Mock = mockMcpCallHandler[check.mock];

    if (!jest.isMockFunction(fn))
      throw new Error(`Unknown mock: ${check.mock}`);

    if (check.notCalled) {
      expect(fn).not.toHaveBeenCalled();
    } else if (check.calledTimes !== undefined) {
      expect(fn).toHaveBeenCalledTimes(check.calledTimes);
    } else if (check.calledWith) {
      expect(fn).toHaveBeenCalledWith(...check.calledWith.map(toMatcher));
    } else {
      expect(fn).toHaveBeenCalled();
    }
  }
}

async function runTest(tc: any) {
  setupMocksForTest(tc.mocks);
  setupEnvForTest(tc.env);

  try {
    const result = await executeTest(tc.input);

    if (tc.expected !== undefined) {
      expect(result).toEqual(toMatcher(tc.expected));
    }

    if (tc.mockCalls) {
      verifyMockCalls(tc.mockCalls);
    }
  } catch (err) {
    // Add custom diagnostics *once*, then re-throw so Jest marks the test as failed.
    if (process.env.TEST_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(`[DEBUG] ${tc.name} failed\n`, err);
    }
    throw err;
  }
}
let originalEnv = {};
function setupEnvForTest(testEnv: any = {}) {
  restoreEnv();
  originalEnv = { ...process.env };
  const merged = { ...(testConfig.env ?? {}), ...testEnv };
  Object.entries(merged).forEach(([key, value]) => {
    process.env[key] = value as string;
  });
}

function restoreEnv() {
  process.env = originalEnv;
}

describe("MCP Dynamic Test Suite", () => {
  beforeEach(() => {
    setupMocksForTest();
    setupEnvForTest();
  });

  afterEach(async () => {
    if (jest.isMockFunction(mockMcpCallHandler.close)) {
      try {
        await mockMcpCallHandler.close();
      } catch {
        /* swallow */
      }
    }
  });

  afterAll(async () => {
    try {
      await mockMcpCallHandler.close?.();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
    jest.clearAllMocks();
    jest.restoreAllMocks();
    restoreEnv();
  });

  for (const tc of testConfig.testCases) {
    it(tc.name, async () => {
      await runTest(tc);
    });
  }
});
