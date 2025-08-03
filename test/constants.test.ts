import { DEFAULT_AWS_REGION } from '../lib/utils/constants';

describe('Constants', () => {
  test('DEFAULT_AWS_REGION is set to ap-southeast-2', () => {
    expect(DEFAULT_AWS_REGION).toBe('ap-southeast-2');
  });

  test('DEFAULT_AWS_REGION is a valid AWS region format', () => {
    expect(DEFAULT_AWS_REGION).toMatch(/^[a-z]{2}-[a-z]+-\d+$/);
  });
});