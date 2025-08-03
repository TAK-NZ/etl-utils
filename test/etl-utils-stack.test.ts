import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EtlUtilsStack } from '../lib/etl-utils-stack';
import { ContextEnvironmentConfig } from '../lib/stack-config';

describe('EtlUtilsStack', () => {
  let app: cdk.App;
  let mockConfig: ContextEnvironmentConfig;

  beforeEach(() => {
    app = new cdk.App();
    mockConfig = {
      stackName: 'Test',
      domain: 'test.tak.nz',
      utilsHostname: 'utils',
      general: {
        removalPolicy: 'DESTROY'
      },
      ecs: {
        desiredCount: 1,
        enableEcsExec: true
      },
      docker: {
        usePreBuiltImages: false,
        imageTag: 'latest'
      },
      containers: {
        'weather-proxy': {
          enabled: true,
          path: '/weather-radar',
          healthCheckPath: '/weather-radar/health',
          port: 3000,
          cpu: 256,
          memory: 512,
          priority: 1
        }
      }
    };
  });

  test('creates stack with required resources', () => {
    const stack = new EtlUtilsStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig: mockConfig
    });

    const template = Template.fromStack(stack);

    // Verify ALB is created
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'application',
      Scheme: 'internet-facing'
    });

    // Verify ECS Service is created
    template.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE'
    });

    // Verify Task Definition is created
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      NetworkMode: 'awsvpc'
    });
  });

  test('creates security groups with correct rules', () => {
    const stack = new EtlUtilsStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig: mockConfig
    });

    const template = Template.fromStack(stack);

    // Verify ALB security group allows HTTP/HTTPS
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [
        {
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIp: '0.0.0.0/0'
        },
        {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0'
        }
      ]
    });
  });

  test('creates IAM roles with S3 permissions', () => {
    const stack = new EtlUtilsStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig: mockConfig
    });

    const template = Template.fromStack(stack);

    // Verify task role has S3 permissions
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Action: 's3:GetObject'
          },
          {
            Effect: 'Allow',
            Action: 's3:ListBucket'
          }
        ]
      }
    });
  });

  test('creates Route53 record for utils hostname', () => {
    const stack = new EtlUtilsStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig: mockConfig
    });

    const template = Template.fromStack(stack);

    // Verify Route53 record is created
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A'
    });
  });

  test('creates target group with health check', () => {
    const stack = new EtlUtilsStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig: mockConfig
    });

    const template = Template.fromStack(stack);

    // Verify target group with health check
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/weather-radar/health',
      Port: 3000,
      Protocol: 'HTTP',
      TargetType: 'ip'
    });
  });

  test('creates CloudWatch log group', () => {
    const stack = new EtlUtilsStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig: mockConfig
    });

    const template = Template.fromStack(stack);

    // Verify log group is created
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/etl-utils-test-weather-proxy'
    });
  });

  test('production environment enables auto scaling', () => {
    const stack = new EtlUtilsStack(app, 'TestStack', {
      environment: 'prod',
      envConfig: mockConfig
    });

    const template = Template.fromStack(stack);

    // Verify auto scaling target is created
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      ServiceNamespace: 'ecs',
      ResourceId: {
        'Fn::Join': [
          '',
          [
            'service/',
            { Ref: 'AWS::NoValue' },
            '/',
            { Ref: 'AWS::NoValue' }
          ]
        ]
      }
    });
  });

  test('creates stack outputs', () => {
    const stack = new EtlUtilsStack(app, 'TestStack', {
      environment: 'dev-test',
      envConfig: mockConfig
    });

    const template = Template.fromStack(stack);

    // Verify required outputs exist
    template.hasOutput('UtilsUrl', {});
    template.hasOutput('LoadBalancerDnsName', {});
    template.hasOutput('UtilsFqdn', {});
    template.hasOutput('weatherproxyUrl', {});
  });
});