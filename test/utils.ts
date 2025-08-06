// Utility functions for CDK tests
import * as cdk from 'aws-cdk-lib';

// CloudFormation template interfaces
export interface CloudFormationResource {
  Type: string;
  Properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CloudFormationOutput {
  Value: unknown;
  Description?: string;
  Export?: { Name: string };
  [key: string]: unknown;
}

export interface CloudFormationTemplate {
  Resources?: Record<string, CloudFormationResource>;
  Outputs?: Record<string, CloudFormationOutput>;
  Parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export function getResourceByType(template: CloudFormationTemplate, type: string): CloudFormationResource[] {
  return Object.values(template.Resources || {}).filter((r: CloudFormationResource) => r.Type === type);
}

export function getOutputByName(template: CloudFormationTemplate, name: string): CloudFormationOutput | undefined {
  return template.Outputs?.[name];
}

/**
 * Creates a CDK App with context values needed for testing
 */
export function createTestApp(): cdk.App {
  const app = new cdk.App({
    context: {
      'dev-test': {
        stackName: 'Dev',
        utilsHostname: 'utils',
        containers: {
          'weather-proxy': {
            enabled: true,
            path: '/weather-radar',
            healthCheckPath: '/weather-radar/health',
            port: 3000,
            cpu: 256,
            memory: 512,
            priority: 1,
            imageTag: 'v2025-08-04'
          },
          'ais-proxy': {
            enabled: true,
            path: '/ais-proxy',
            healthCheckPath: '/ais-proxy/health',
            port: 3000,
            cpu: 256,
            memory: 512,
            priority: 2,
            imageTag: 'v2025-08-04'
          }
        },
        general: {
          removalPolicy: 'DESTROY'
        },
        ecs: {
          desiredCount: 1,
          enableEcsExec: false
        },
        docker: {
          usePreBuiltImages: false
        }
      },
      'prod': {
        stackName: 'Prod',
        utilsHostname: 'utils',
        containers: {
          'weather-proxy': {
            enabled: true,
            path: '/weather-radar',
            healthCheckPath: '/weather-radar/health',
            port: 3000,
            cpu: 512,
            memory: 1024,
            priority: 1,
            imageTag: 'v2025-08-04'
          },
          'ais-proxy': {
            enabled: true,
            path: '/ais-proxy',
            healthCheckPath: '/ais-proxy/health',
            port: 3000,
            cpu: 512,
            memory: 1024,
            priority: 2,
            imageTag: 'v2025-08-04'
          }
        },
        general: {
          removalPolicy: 'RETAIN'
        },
        ecs: {
          desiredCount: 2,
          enableEcsExec: true
        },
        docker: {
          usePreBuiltImages: true
        }
      },
      'tak-defaults': {
        project: 'TAK',
        component: 'EtlUtils',
        region: 'ap-southeast-2'
      }
    }
  });
  return app;
}

/**
 * Mock CloudFormation imports for testing
 */
export function mockCloudFormationImports(app: cdk.App): void {
  app.node.setContext('TAK-Dev-BaseInfra-VpcId', 'vpc-12345678');
  app.node.setContext('TAK-Dev-BaseInfra-SubnetPrivateA', 'subnet-private-a');
  app.node.setContext('TAK-Dev-BaseInfra-SubnetPrivateB', 'subnet-private-b');
  app.node.setContext('TAK-Dev-BaseInfra-SubnetPublicA', 'subnet-public-a');
  app.node.setContext('TAK-Dev-BaseInfra-SubnetPublicB', 'subnet-public-b');
  app.node.setContext('TAK-Dev-BaseInfra-EcsCluster', 'arn:aws:ecs:ap-southeast-2:123456789012:cluster/TAK-Dev-BaseInfra');
  app.node.setContext('TAK-Dev-BaseInfra-CertificateArn', 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012');
  app.node.setContext('TAK-Dev-BaseInfra-HostedZoneId', 'Z1PA6795UKMFR9');
  app.node.setContext('TAK-Dev-BaseInfra-HostedZoneName', 'dev.tak.nz');
  app.node.setContext('TAK-Dev-BaseInfra-S3ElbLogs', 'arn:aws:s3:::tak-dev-logs-bucket');
  app.node.setContext('TAK-Dev-BaseInfra-EnvConfigBucket', 'arn:aws:s3:::tak-dev-config-bucket');
  app.node.setContext('TAK-Dev-BaseInfra-KmsKey', 'arn:aws:kms:ap-southeast-2:123456789012:key/12345678-1234-1234-1234-123456789012');
  app.node.setContext('TAK-Dev-BaseInfra-EcrEtlRepo', 'arn:aws:ecr:ap-southeast-2:123456789012:repository/tak-dev-etl-utils');
}