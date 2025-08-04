/**
 * CloudFormation import utilities for referencing base infrastructure resources
 */

/**
 * Base infrastructure export names (from base-infra stack)
 */
export const BASE_EXPORT_NAMES = {
  VPC_ID: 'VpcId',
  VPC_CIDR_IPV4: 'VpcCidrIpv4',
  SUBNET_PUBLIC_A: 'SubnetPublicA',
  SUBNET_PUBLIC_B: 'SubnetPublicB',
  SUBNET_PRIVATE_A: 'SubnetPrivateA',
  SUBNET_PRIVATE_B: 'SubnetPrivateB',
  ECS_CLUSTER: 'EcsClusterArn',
  ECR_REPO: 'EcrArtifactsRepoArn',
  ECR_ETL_REPO: 'EcrEtlTasksRepoArn',
  KMS_KEY: 'KmsKeyArn',
  KMS_ALIAS: 'KmsAlias',
  S3_ENV_CONFIG: 'S3EnvConfigArn',
  ENV_CONFIG_BUCKET: 'S3EnvConfigArn',
  S3_APP_IMAGES: 'S3TAKImagesArn',
  S3_ELB_LOGS: 'S3ElbLogsArn',
  CERTIFICATE_ARN: 'CertificateArn',
  HOSTED_ZONE_ID: 'HostedZoneId',
  HOSTED_ZONE_NAME: 'HostedZoneName',

} as const;

/**
 * Create CloudFormation import value for base infrastructure resources
 */
export function createBaseImportValue(stackNameComponent: string, exportName: string): string {
  return `TAK-${stackNameComponent}-BaseInfra-${exportName}`;
}