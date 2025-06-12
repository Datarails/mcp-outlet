export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: [
    '<rootDir>/src/js/tests/**/*.test.ts',
    '<rootDir>/src/js/tests/**/*.spec.ts'
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.ts$': '$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^(\\.{1,2}/.*)\\.mjs$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ES2022',
        target: 'ES2022'
      }
    }],
    '^.+\\.m?js$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ES2022',
        target: 'ES2022',
        allowJs: true
      }
    }]
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@aws-sdk|@jest|nanoid)/)'
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/.serverless/'
  ],
  setupFilesAfterEnv: ['<rootDir>/src/js/tests/setup.ts'],
  collectCoverageFrom: [
    'src/js/handlers/**/*.ts',
    '!src/js/handlers/**/*.d.ts',
    '!src/js/tests/**/*'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000,
  verbose: true
}; 