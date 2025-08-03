import { createBaseImportValue, BASE_EXPORT_NAMES } from '../lib/cloudformation-imports';

describe('CloudFormation Imports', () => {
  test('creates correct import value format', () => {
    const importValue = createBaseImportValue('Test', 'VpcId');
    expect(importValue).toBe('TAK-Test-BaseInfra-VpcId');
  });

  test('handles different stack name components', () => {
    expect(createBaseImportValue('Dev', 'VpcId')).toBe('TAK-Dev-BaseInfra-VpcId');
    expect(createBaseImportValue('Prod', 'VpcId')).toBe('TAK-Prod-BaseInfra-VpcId');
  });

  test('BASE_EXPORT_NAMES contains required exports', () => {
    expect(BASE_EXPORT_NAMES.VPC_ID).toBe('VpcId');
    expect(BASE_EXPORT_NAMES.ECS_CLUSTER).toBe('EcsClusterArn');
    expect(BASE_EXPORT_NAMES.ENV_CONFIG_BUCKET).toBe('S3EnvConfigArn');
  });
});