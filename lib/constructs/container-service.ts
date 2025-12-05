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
  Token,
  Stack
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

    // Add init container for tileserver-gl MBTiles download
    let initContainer: ecs.ContainerDefinition | undefined;
    if (containerName === 'tileserver-gl' && efsAccessPoint && 
        (containerConfig.mbtiles?.enabled || containerConfig.mbtilesMulti?.enabled)) {
      
      // Build download commands for all mbtiles files
      let downloadCommands: string[] = [];
      
      // Handle single mbtiles config (backward compatibility)
      if (containerConfig.mbtiles?.enabled) {
        downloadCommands.push(`
          TILE_PATH="/tiles/${containerConfig.mbtiles.filename}" && 
          S3_PATH="s3://$S3_BUCKET/${containerConfig.mbtiles.s3Key}" && 
          echo "Checking for tile file: $TILE_PATH" && 
          if [ "$FORCE_DOWNLOAD" = "true" ] || [ ! -f "$TILE_PATH" ]; then 
            if [ "$FORCE_DOWNLOAD" = "true" ] && [ -f "$TILE_PATH" ]; then 
              echo "FORCE_DOWNLOAD=true - removing existing file" && 
              rm "$TILE_PATH"; 
            fi && 
            echo "Downloading MBTiles from S3: $S3_PATH" && 
            echo "Target path: $TILE_PATH" && 
            aws s3 cp "$S3_PATH" "$TILE_PATH" --no-progress && 
            echo "Download completed: $(ls -lh $TILE_PATH)" && 
            echo "File size: $(du -h $TILE_PATH)"; 
          else 
            echo "Tile file already exists: $(ls -lh $TILE_PATH)"; 
          fi`);
      }
      
      // Handle multiple mbtiles config
      if (containerConfig.mbtilesMulti?.enabled) {
        containerConfig.mbtilesMulti.files.forEach(file => {
          downloadCommands.push(`
            TILE_PATH="/tiles/${file.filename}" && 
            S3_PATH="s3://$S3_BUCKET/${file.s3Key}" && 
            echo "Checking for tile file: $TILE_PATH" && 
            if [ "$FORCE_DOWNLOAD" = "true" ] || [ ! -f "$TILE_PATH" ]; then 
              if [ "$FORCE_DOWNLOAD" = "true" ] && [ -f "$TILE_PATH" ]; then 
                echo "FORCE_DOWNLOAD=true - removing existing file" && 
                rm "$TILE_PATH"; 
              fi && 
              echo "Downloading MBTiles from S3: $S3_PATH" && 
              echo "Target path: $TILE_PATH" && 
              aws s3 cp "$S3_PATH" "$TILE_PATH" --no-progress && 
              echo "Download completed: $(ls -lh $TILE_PATH)" && 
              echo "File size: $(du -h $TILE_PATH)"; 
            else 
              echo "Tile file already exists: $(ls -lh $TILE_PATH)"; 
            fi`);
        });
      }
      
      const allDownloadCommands = downloadCommands.join(' && ');
      
      initContainer = this.taskDefinition.addContainer('TileDownloader', {
        containerName: 'tile-downloader',
        image: ecs.ContainerImage.fromRegistry('alpine:latest'),
        essential: false,
        memoryReservationMiB: 512,
        cpu: 256,
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'tile-downloader',
          logGroup: logGroup,
        }),
        environment: {
          S3_BUCKET: environmentVariables.S3_BUCKET || '',
          AWS_DEFAULT_REGION: Stack.of(this).region,
          FORCE_DOWNLOAD: environmentVariables.FORCE_DOWNLOAD || 'false'
        },
        command: [
          '/bin/sh',
          '-c',
          `set -e && 
           echo "Installing AWS CLI..." && 
           apk add --no-cache aws-cli curl && 
           echo "AWS CLI installed" && 
           echo "Available memory: $(free -h)" && 
           echo "Available disk space: $(df -h /tiles)" && 
           ${allDownloadCommands} && 
           echo "All tile preparation complete - container will exit successfully"`
        ]
      });

      initContainer.addMountPoints({
        sourceVolume: 'efs-volume',
        containerPath: '/tiles',
        readOnly: false
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
      } else if (containerName === 'tileserver-gl') {
        container.addMountPoints({
          sourceVolume: 'efs-volume',
          containerPath: '/data/tiles',
          readOnly: true
        });
      } else if (containerName === 'mapproxy') {
        container.addMountPoints({
          sourceVolume: 'efs-volume',
          containerPath: '/cache',
          readOnly: false
        });
      }
    }

    // Add container dependencies for init containers
    if (initContainer) {
      container.addContainerDependencies({
        container: initContainer,
        condition: ecs.ContainerDependencyCondition.SUCCESS
      });
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