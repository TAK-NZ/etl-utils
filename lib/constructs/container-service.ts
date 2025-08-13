/**
 * Container Service Construct - Individual container service deployment
 */
import { Construct } from 'constructs';
import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_logs as logs,
  aws_iam as iam,
  aws_efs as efs,
  Duration,
  RemovalPolicy,
  Fn,
  Token
} from 'aws-cdk-lib';
import type { ContextEnvironmentConfig, ContainerConfig } from '../stack-config';
import { createBaseImportValue, BASE_EXPORT_NAMES } from '../cloudformation-imports';

/**
 * Properties for the ContainerService construct
 */
export interface ContainerServiceProps {
  /**
   * Environment type ('prod' | 'dev-test')
   */
  environment: 'prod' | 'dev-test';

  /**
   * Context-based environment configuration
   */
  contextConfig: ContextEnvironmentConfig;

  /**
   * Container name (e.g., 'weather-proxy')
   */
  containerName: string;

  /**
   * Container configuration
   */
  containerConfig: ContainerConfig;

  /**
   * ECS cluster
   */
  ecsCluster: ecs.ICluster;

  /**
   * ECS security group
   */
  ecsSecurityGroup: ec2.ISecurityGroup;

  /**
   * Task role for ECS tasks
   */
  taskRole: iam.IRole;

  /**
   * Task execution role for ECS tasks
   */
  taskExecutionRole: iam.IRole;

  /**
   * Container image URI (optional, for dual image strategy)
   */
  containerImageUri?: string;

  /**
   * Additional environment variables (optional)
   */
  environmentVariables?: { [key: string]: string };

  /**
   * Stack name component for imports
   */
  stackNameComponent: string;

  /**
   * EFS access point (optional, for persistent storage)
   */
  efsAccessPoint?: efs.IAccessPoint;
}

/**
 * CDK construct for individual container service
 */
export class ContainerService extends Construct {
  /**
   * ECS service
   */
  public readonly service: ecs.FargateService;

  /**
   * Target group for ALB
   */
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  /**
   * Task definition
   */
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: ContainerServiceProps) {
    super(scope, id);

    const {
      environment,
      contextConfig,
      containerName,
      containerConfig,
      ecsCluster,
      ecsSecurityGroup,
      taskRole,
      taskExecutionRole,
      containerImageUri,
      environmentVariables = {},
      stackNameComponent,
      efsAccessPoint
    } = props;

    // Create CloudWatch log group - let CDK generate unique name to avoid conflicts
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: environment === 'prod' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: contextConfig.general.removalPolicy === 'DESTROY' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    // Create task definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `TAK-${contextConfig.stackName}-ETL-Utils-${containerName}`,
      cpu: containerConfig.cpu,
      memoryLimitMiB: containerConfig.memory,
      taskRole,
      executionRole: taskExecutionRole,
    });

    // Add EFS volume if needed
    if (efsAccessPoint) {
      this.taskDefinition.addVolume({
        name: 'efs-volume',
        efsVolumeConfiguration: {
          fileSystemId: efsAccessPoint.fileSystem.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: {
            accessPointId: efsAccessPoint.accessPointId,
            iam: 'ENABLED'
          }
        }
      });
    }

    // Determine container image
    let containerImage: ecs.ContainerImage;
    if (containerImageUri) {
      // Use pre-built image from ECR
      containerImage = ecs.ContainerImage.fromRegistry(containerImageUri);
    } else {
      // Use local Docker build
      containerImage = ecs.ContainerImage.fromAsset(`./${containerName}`);
    }

    // Add container to task definition
    const container = this.taskDefinition.addContainer('Container', {
      containerName,
      image: containerImage,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: containerName,
        logGroup,
      }),
      portMappings: [
        {
          containerPort: containerConfig.port,
          protocol: ecs.Protocol.TCP,
        },
      ],
      environment: {
        NODE_ENV: environment === 'prod' ? 'production' : 'development',
        PORT: containerConfig.port.toString(),
        ...environmentVariables,
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          `curl -f http://localhost:${containerConfig.port}${containerConfig.healthCheckPath} || exit 1`
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });

    // Add EFS mount points
    if (efsAccessPoint) {
      if (containerName === 'ais-proxy') {
        container.addMountPoints({
          sourceVolume: 'efs-volume',
          containerPath: '/data',
          readOnly: false
        });
      } else if (containerName === 'mapproxy') {
        container.addMountPoints({
          sourceVolume: 'efs-volume',
          containerPath: '/cache',
          readOnly: false
        });
      }
    }

    // Create target group
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: ecsCluster.vpc,
      targetType: elbv2.TargetType.IP,
      port: containerConfig.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        enabled: true,
        path: containerConfig.healthCheckPath,
        protocol: elbv2.Protocol.HTTP,
        port: containerConfig.port.toString(),
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Create ECS service
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `TAK-${contextConfig.stackName}-ETL-Utils-${containerName}`,
      cluster: ecsCluster,
      taskDefinition: this.taskDefinition,
      desiredCount: contextConfig.ecs.desiredCount,
      securityGroups: [ecsSecurityGroup],
      assignPublicIp: false, // Deploy in private subnets
      enableExecuteCommand: contextConfig.ecs.enableEcsExec,
      healthCheckGracePeriod: Duration.seconds(120),

    });

    // Attach service to target group
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    // Configure auto scaling if in production
    if (environment === 'prod') {
      const scaling = this.service.autoScaleTaskCount({
        minCapacity: 1,
        maxCapacity: 5,
      });

      scaling.scaleOnCpuUtilization('CpuScaling', {
        targetUtilizationPercent: 70,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(2),
      });

      scaling.scaleOnMemoryUtilization('MemoryScaling', {
        targetUtilizationPercent: 80,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(2),
      });
    }
  }
}