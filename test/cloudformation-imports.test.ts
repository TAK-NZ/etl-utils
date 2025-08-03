import { createBaseImportValue, BASE_EXPORT_NAMES } from '../lib/cloudformation-imports';

describe('CloudFormation Imports', () => {
  test('creates correct import value format', () => {
    const importValue = createBaseImportValue('Test', 'VpcId');
    expect(importValue).toBe('TAK-Test-BaseInfra-VpcId');
  });

  test('handles different stack name components', () => {
    expect(createBaseImportValue('Dev', 'VpcId')).toBe('TAK-Dev-BaseInfra-VpcId');
    expect(createBaseImportValue('Prod', 'VpcId')).toBe('TAK-Prod-BaseInfra-VpcId');
    expect(createBaseImportValue('Demo', 'VpcId')).toBe('TAK-Demo-BaseInfra-VpcId');
  });

  test('BASE_EXPORT_NAMES contains required exports', () => {
    expect(BASE_EXPORT_NAMES.VPC_ID).toBe('VpcId');
    expect(BASE_EXPORT_NAMES.SUBNET_PUBLIC_A).toBe('SubnetPublicA');
    expect(BASE_EXPORT_NAMES.SUBNET_PUBLIC_B).toBe('SubnetPublicB');
    expect(BASE_EXPORT_NAMES.SUBNET_PRIVATE_A).toBe('SubnetPrivateA');
    expect(BASE_EXPORT_NAMES.SUBNET_PRIVATE_B).toBe('SubnetPrivateB');
    expect(BASE_EXPORT_NAMES.ECS_CLUSTER).toBe('EcsClusterArn');
    expect(BASE_EXPORT_NAMES.CERTIFICATE_ARN).toBe('CertificateArn');
    expect(BASE_EXPORT_NAMES.HOSTED_ZONE_ID).toBe('HostedZoneId');
    expect(BASE_EXPORT_NAMES.HOSTED_ZONE_NAME).toBe('HostedZoneName');
    expect(BASE_EXPORT_NAMES.ENV_CONFIG_BUCKET).toBe('S3EnvConfigArn');
  });

  test('creates import values for all export names', () => {
    Object.entries(BASE_EXPORT_NAMES).forEach(([key, exportName]) => {
      const importValue = createBaseImportValue('Test', exportName);
      expect(importValue).toBe(`TAK-Test-BaseInfra-${exportName}`);
      expect(importValue).toMatch(/^TAK-Test-BaseInfra-/);
    });
  });
});