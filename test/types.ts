export const ANY_STRING = { __kind: "ANY_STRING" } as const;
export const ANY_NUMBER = { __kind: "ANY_NUMBER" } as const;
export const ANY_DATE = { __kind: "ANY_DATE" } as const;
export const ANY_OBJECT = { __kind: "ANY_OBJECT" } as const;
export const ANYTHING = { __kind: "ANYTHING" } as const;

export const STRING_CONTAINING = (substring: string) => ({
  __kind: "STRING_CONTAINING" as const,
  substring,
});

export const OBJECT_CONTAINING = (partial: any) => ({
  __kind: "OBJECT_CONTAINING" as const,
  partial,
});

export const NOT_OBJECT_CONTAINING = (partial: any) => ({
  __kind: "NOT_OBJECT_CONTAINING" as const,
  partial,
});

export interface MockBehavior {
  /** Returned value when the mock resolves. */
  returns?: unknown; // e.g. 42, { tools: [] }, "mockClient"
  /** Value or message to throw when the mock rejects. */
  throws?: Record<string, any>;
  /** Custom implementation to execute instead of the default stub. */
  implementation?: (...args: unknown[]) => unknown;
}

export type MocksConfig = {
  [k: string]: MockBehavior;
};

export interface MockCallCheck {
  /** The mock being verified – "createClientFromConfig" or "mcpClient.<method>" */
  mock: string;
  /** Expect the mock never to have been invoked. */
  notCalled?: boolean;
  /** Expect the mock to have been invoked exactly N times. */
  calledTimes?: number;
  /** Positional arguments the mock should have been called with. */
  calledWith?: unknown[];
}

export interface TestCase {
  /** Human-readable title shown by Jest. */
  name: string;

  /** JSON-RPC request fed to `rpc.execute`. */
  input: unknown;

  /** Success result, error object, or `undefined` for notifications. */
  expected?: unknown;

  /** Per-test mock overrides (merged over suite-level `mocks`). */
  mocks?: MocksConfig;

  /** Per-test env-var overrides (merged over suite-level `env`). */
  env?: Record<string, string>;

  /** Post-execution expectations about how mocks were used. */
  mockCalls?: MockCallCheck[];
}

export interface TestSuiteConfig {
  /** Env vars applied to every test unless overridden. */
  env?: Record<string, string>;

  /** Default mocks applied to every test unless overridden. */
  mocks?: MocksConfig;

  /** The list of test cases executed by the runner. */
  testCases: TestCase[];
}
