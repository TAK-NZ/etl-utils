import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as efs from 'aws-cdk-lib/aws-efs';
import { ContainerService } from '../../lib/constructs/container-service';
import { createTestApp } from '../utils';

describe('ContainerService Construct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let vpc: ec2.IVpc;
  let ecsCluster: ecs.ICluster;
  let ecsSecurityGroup: ec2.ISecurityGroup;
  let taskRole: iam.IRole;
  let taskExecutionRole: iam.IRole;

  beforeEach(() => {
    app = createTestApp();
    stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });
    
    vpc = new ec2.Vpc(stack, 'TestVpc');
    ecsCluster = new ecs.Cluster(stack, 'TestCluster', { vpc });
    ecsSecurityGroup = new ec2.SecurityGroup(stack, 'TestEcsSg', { vpc });
    taskRole = new iam.Role(stack, 'TestTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });
    taskExecutionRole = new iam.Role(stack, 'TestTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });
  });

  it('creates ECS service with correct configuration for dev-test', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    const containerConfig = envConfig.containers['weather-proxy'];
    
    const containerService = new ContainerService(stack, 'WeatherProxyService', {
      environment: 'dev-test',
      contextConfig: envConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      stackNameComponent: 'Dev',
    });

    const template = Template.fromStack(stack);

    // Check ECS service
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'TAK-Dev-ETL-Utils-weather-proxy',
      DesiredCount: 1,
      LaunchType: 'FARGATE',
    });

    // Check task definition
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'TAK-Dev-ETL-Utils-weather-proxy',
      Cpu: '256',
      Memory: '512',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
    });

    expect(containerService.service).toBeDefined();
    expect(containerService.targetGroup).toBeDefined();
    expect(containerService.taskDefinition).toBeDefined();
  });

  it('creates target group with health check configuration', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    const containerConfig = envConfig.containers['ais-proxy'];
    
    new ContainerService(stack, 'AisProxyService', {
      environment: 'dev-test',
      contextConfig: envConfig,
      containerName: 'ais-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      stackNameComponent: 'Dev',
    });

    const template = Template.fromStack(stack);

    // Check target group
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'TAK-Dev-ETL-Utils-ais-proxy',
      Port: 3000,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/ais-proxy/health',
      HealthCheckIntervalSeconds: 30,
      HealthCheckTimeoutSeconds: 5,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 3,
    });
  });

  it('creates CloudWatch log group with correct retention', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    const containerConfig = envConfig.containers['weather-proxy'];
    
    new ContainerService(stack, 'WeatherProxyService', {
      environment: 'dev-test',
      contextConfig: envConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      stackNameComponent: 'Dev',
    });

    const template = Template.fromStack(stack);

    // Check log group
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/TAK-Dev-ETL-Utils-weather-proxy',
      RetentionInDays: 7, // dev-test environment
    });
  });

  it('configures production log retention correctly', () => {
    const envConfig = app.node.tryGetContext('prod');
    const containerConfig = envConfig.containers['weather-proxy'];
    
    new ContainerService(stack, 'WeatherProxyService', {
      environment: 'prod',
      contextConfig: envConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      stackNameComponent: 'Prod',
    });

    const template = Template.fromStack(stack);

    // Check production log retention
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 30, // production environment
    });
  });

  it('uses pre-built image when containerImageUri is provided', () => {
    const envConfig = app.node.tryGetContext('prod');
    const containerConfig = envConfig.containers['weather-proxy'];
    
    new ContainerService(stack, 'WeatherProxyService', {
      environment: 'prod',
      contextConfig: envConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      containerImageUri: '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/tak-prod-etl-utils:weather-proxy-v1.0.0',
      stackNameComponent: 'Prod',
    });

    const template = Template.fromStack(stack);

    // Check container definition uses ECR image
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [{
        Name: 'weather-proxy',
        Image: '123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/tak-prod-etl-utils:weather-proxy-v1.0.0',
        Essential: true,
      }]
    });
  });

  it('configures auto scaling for production environment', () => {
    const envConfig = app.node.tryGetContext('prod');
    const containerConfig = envConfig.containers['weather-proxy'];
    
    new ContainerService(stack, 'WeatherProxyService', {
      environment: 'prod',
      contextConfig: envConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      stackNameComponent: 'Prod',
    });

    const template = Template.fromStack(stack);

    // Check auto scaling target exists
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      ServiceNamespace: 'ecs',
      ScalableDimension: 'ecs:service:DesiredCount',
      MinCapacity: 1,
      MaxCapacity: 5,
    });

    // Check CPU scaling policy
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'TargetTrackingScaling',
      TargetTrackingScalingPolicyConfiguration: {
        TargetValue: 70,
        PredefinedMetricSpecification: {
          PredefinedMetricType: 'ECSServiceAverageCPUUtilization'
        }
      }
    });

    // Check memory scaling policy
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'TargetTrackingScaling',
      TargetTrackingScalingPolicyConfiguration: {
        TargetValue: 80,
        PredefinedMetricSpecification: {
          PredefinedMetricType: 'ECSServiceAverageMemoryUtilization'
        }
      }
    });
  });

  it('does not configure auto scaling for dev-test environment', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    const containerConfig = envConfig.containers['weather-proxy'];
    
    new ContainerService(stack, 'WeatherProxyService', {
      environment: 'dev-test',
      contextConfig: envConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      stackNameComponent: 'Dev',
    });

    const template = Template.fromStack(stack);

    // Should not have auto scaling resources
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 0);
  });

  it('adds EFS volume and mount point for ais-proxy', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    const containerConfig = envConfig.containers['ais-proxy'];
    
    // Create EFS file system and access point
    const efsFileSystem = new efs.FileSystem(stack, 'TestEfs', { vpc });
    const efsAccessPoint = new efs.AccessPoint(stack, 'TestAccessPoint', {
      fileSystem: efsFileSystem,
    });
    
    new ContainerService(stack, 'AisProxyService', {
      environment: 'dev-test',
      contextConfig: envConfig,
      containerName: 'ais-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      stackNameComponent: 'Dev',
      efsAccessPoint,
    });

    const template = Template.fromStack(stack);

    // Check EFS volume configuration
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Volumes: [{
        Name: 'efs-volume',
        EFSVolumeConfiguration: {
          TransitEncryption: 'ENABLED',
          AuthorizationConfig: {
            IAM: 'ENABLED'
          }
        }
      }]
    });

    // Check mount point
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [{
        MountPoints: [{
          SourceVolume: 'efs-volume',
          ContainerPath: '/data',
          ReadOnly: false
        }]
      }]
    });
  });

  it('sets correct environment variables', () => {
    const envConfig = app.node.tryGetContext('prod');
    const containerConfig = envConfig.containers['weather-proxy'];
    
    new ContainerService(stack, 'WeatherProxyService', {
      environment: 'prod',
      contextConfig: envConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      environmentVariables: {
        CONFIG_BUCKET: 'test-bucket',
        CONFIG_KEY: 'test-key.json'
      },
      stackNameComponent: 'Prod',
    });

    const template = Template.fromStack(stack);

    // Check environment variables
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [{
        Environment: Match.arrayWith([
          { Name: 'NODE_ENV', Value: 'production' },
          { Name: 'PORT', Value: '3000' },
          { Name: 'CONFIG_BUCKET', Value: 'test-bucket' },
          { Name: 'CONFIG_KEY', Value: 'test-key.json' }
        ])
      }]
    });
  });

  it('configures health check correctly', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    const containerConfig = envConfig.containers['weather-proxy'];
    
    new ContainerService(stack, 'WeatherProxyService', {
      environment: 'dev-test',
      contextConfig: envConfig,
      containerName: 'weather-proxy',
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      stackNameComponent: 'Dev',
    });

    const template = Template.fromStack(stack);

    // Check health check configuration
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [{
        HealthCheck: {
          Command: ['CMD-SHELL', 'curl -f http://localhost:3000/weather-radar/health || exit 1'],
          Interval: 30,
          Timeout: 5,
          Retries: 3,
          StartPeriod: 60
        }
      }]
    });
  });
});