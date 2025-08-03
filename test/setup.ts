/**
 * Test setup for ETL Utils CDK tests
 */

// Set required environment variables for CDK
process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
process.env.CDK_DEFAULT_REGION = 'us-east-1';
process.env.NODE_ENV = 'test';

// Suppress CDK warnings in tests
const originalWarn = console.warn;
const originalError = console.error;

beforeAll(() => {
  console.warn = jest.fn();
  console.error = jest.fn();
});

afterAll(() => {
  console.warn = originalWarn;
  console.error = originalError;
});