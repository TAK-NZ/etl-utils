import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template } from 'aws-cdk-lib/assertions';
import { ContainerService } from '../../lib/constructs/container-service';
import { ContextEnvironmentConfig, ContainerConfig } from '../../lib/stack-config';

describe('ContainerService Construct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let vpc: ec2.IVpc;
  let ecsCluster: ecs.ICluster;
  let ecsSecurityGroup: ec2.ISecurityGroup;
  let taskRole: iam.IRole;
  let taskExecutionRole: iam.IRole;
  let mockConfig: ContextEnvironmentConfig;
  let containerConfig: ContainerConfig;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    vpc = new ec2.Vpc(stack, 'TestVpc');
    ecsCluster = new ecs.Cluster(stack, 'TestCluster', { vpc });
    ecsSecurityGroup = new ec2.SecurityGroup(stack, 'TestSG', { vpc });
    taskRole = new iam.Role(stack, 'TestTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });
    taskExecutionRole = new iam.Role(stack, 'TestExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    mockConfig = {
      stackName: 'Test',
      domain: 'test.tak.nz',
      utilsHostname: 'utils',
      general: { removalPolicy: 'DESTROY' },
      ecs: { desiredCount: 1, enableEcsExec: true },
      docker: { usePreBuiltImages: false, imageTag: 'latest' },
      containers: {}
    };

    containerConfig = {
      enabled: true,
      path: '/weather-radar',
      healthCheckPath: '/weather-radar/health',
      port: 3000,
      cpu: 256,
      memory: 512,
      priority: 1
    };
  });

  test('creates ECS task definition', () => {
    new ContainerService(stack, 'TestService', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      NetworkMode: 'awsvpc',
      Cpu: '256',
      Memory: '512'
    });
  });

  test('creates ECS service', () => {
    new ContainerService(stack, 'TestService', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
      DesiredCount: 1
    });
  });

  test('creates target group with health check', () => {
    new ContainerService(stack, 'TestService', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/weather-radar/health',
      Port: 3000,
      Protocol: 'HTTP',
      TargetType: 'ip'
    });
  });

  test('creates CloudWatch log group', () => {
    new ContainerService(stack, 'TestService', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/etl-utils-test-weather-proxy'
    });
  });

  test('enables auto scaling in production', () => {
    new ContainerService(stack, 'TestService', {
      environment: 'prod',
      contextConfig: mockConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      ServiceNamespace: 'ecs',
      ScalableDimension: 'ecs:service:DesiredCount'
    });
  });

  test('includes environment variables', () => {
    new ContainerService(stack, 'TestService', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      environmentVariables: {
        CONFIG_BUCKET: 'test-bucket',
        CONFIG_KEY: 'test-key.json'
      }
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        {
          Environment: [
            { Name: 'NODE_ENV', Value: 'development' },
            { Name: 'PORT', Value: '3000' },
            { Name: 'CONFIG_BUCKET', Value: 'test-bucket' },
            { Name: 'CONFIG_KEY', Value: 'test-key.json' }
          ]
        }
      ]
    });
  });
});