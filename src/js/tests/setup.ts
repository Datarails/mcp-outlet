import { jest } from "@jest/globals";

export const mockMcpCallHandler = {
  executeMcpCall: jest.fn(),
  connect: jest.fn(),
  close: jest.fn(),
};

jest.unstable_mockModule("../helpers/McpCaller.ts", () => ({
  __esModule: true,
  McpCaller: jest.fn().mockImplementation((config) => ({
    ...mockMcpCallHandler,
    config,
  })),
}));

// Helper to reset mocks
export const resetMocks = () => {
  Object.values(mockMcpCallHandler).forEach((fn) => {
    if (jest.isMockFunction(fn)) fn.mockReset();
  });
};

// Global test adapter instance for reuse across tests
export default {
  // Add any additional global configuration here
};
