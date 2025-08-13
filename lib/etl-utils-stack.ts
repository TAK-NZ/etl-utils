import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as efs from 'aws-cdk-lib/aws-efs';
// Construct imports
import { SecurityGroups } from './constructs/security-groups';
import { Alb } from './constructs/alb';
import { ContainerService } from './constructs/container-service';
import { CloudFront } from './constructs/cloudfront';
import { ApiAuth } from './constructs/api-auth';

// Utility imports
import { ContextEnvironmentConfig } from './stack-config';
import { createBaseImportValue, BASE_EXPORT_NAMES } from './cloudformation-imports';

export interface EtlUtilsStackProps extends StackProps {
  environment: 'prod' | 'dev-test';
  envConfig: ContextEnvironmentConfig;
}

/**
 * Main CDK stack for ETL Utils Infrastructure
 */
export class EtlUtilsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EtlUtilsStackProps) {
    super(scope, id, {
      ...props,
      description: 'ETL Utils Infrastructure - Multiple Docker containers on ECS Fargate with ALB',
    });

    const { environment, envConfig } = props;
    const stackNameComponent = envConfig.stackName;
    const region = cdk.Stack.of(this).region;

    // =================
    // IMPORT BASE INFRASTRUCTURE RESOURCES
    // =================

    // Import VPC from base-infra
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.VPC_ID)),
      availabilityZones: [region + 'a', region + 'b'],
      privateSubnetIds: [
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PRIVATE_A)),
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PRIVATE_B))
      ],
      publicSubnetIds: [
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PUBLIC_A)),
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PUBLIC_B))
      ]
    });

    // Import ECS cluster from base-infra
    const ecsCluster = ecs.Cluster.fromClusterAttributes(this, 'ImportedEcsCluster', {
      clusterName: `TAK-${stackNameComponent}-BaseInfra`,
      clusterArn: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.ECS_CLUSTER)),
      vpc: vpc
    });

    // Import SSL certificate from base-infra
    const certificate = acm.Certificate.fromCertificateArn(this, 'ImportedCertificate',
      Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.CERTIFICATE_ARN))
    );

    // Import Route53 hosted zone from base-infra
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      hostedZoneId: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.HOSTED_ZONE_ID)),
      zoneName: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.HOSTED_ZONE_NAME)),
    });

    // =================
    // CREATE SECURITY GROUPS
    // =================

    const securityGroups = new SecurityGroups(this, 'SecurityGroups', {
      vpc,
      stackNameComponent,
    });

    // =================
    // CREATE EFS FILE SYSTEM
    // =================

    const efsFileSystem = new efs.FileSystem(this, 'EfsFileSystem', {
      vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: envConfig.general.removalPolicy === 'DESTROY' ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
      securityGroup: securityGroups.efs,
      fileSystemPolicy: iam.PolicyDocument.fromJson({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              AWS: '*'
            },
            Action: [
              'elasticfilesystem:ClientMount',
              'elasticfilesystem:ClientWrite',
              'elasticfilesystem:ClientRootAccess'
            ],
            Condition: {
              Bool: {
                'elasticfilesystem:AccessedViaMountTarget': 'true'
              }
            }
          }
        ]
      })
    });

    // Create EFS access point for ais-proxy
    const aisProxyAccessPoint = new efs.AccessPoint(this, 'AisProxyAccessPoint', {
      fileSystem: efsFileSystem,
      posixUser: {
        uid: '1001',
        gid: '1001'
      },
      path: '/ais-proxy',
      createAcl: {
        ownerUid: '1001',
        ownerGid: '1001',
        permissions: '755'
      }
    });

    // =================
    // CREATE API AUTHENTICATION
    // =================

    const apiAuth = new ApiAuth(this, 'ApiAuth', {
      environment,
      contextConfig: envConfig,
    });

    // =================
    // CREATE APPLICATION LOAD BALANCER
    // =================

    const alb = new Alb(this, 'Alb', {
      environment,
      contextConfig: envConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup: securityGroups.alb,
    });

    // =================
    // CREATE IAM ROLES
    // =================

    // Task execution role
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `TAK-${stackNameComponent}-ETL-Utils-task-execution`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task role
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `TAK-${stackNameComponent}-ETL-Utils-task`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Add ECS Exec permissions if enabled
    if (envConfig.ecs.enableEcsExec) {
      taskRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
      );
    }

    // Grant S3 access to config bucket for API keys
    const configBucketArn = Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.ENV_CONFIG_BUCKET));
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      resources: [`${configBucketArn}/*`],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:ListBucket'],
      resources: [configBucketArn],
    }));

    // Grant KMS decrypt permissions for S3 bucket
    const kmsKeyArn = Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.KMS_KEY));
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['kms:Decrypt'],
      resources: [kmsKeyArn],
    }));

    // S3 permissions already granted above for config bucket access

    // Add EFS permissions for task role (needed for ais-proxy)
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:ClientRootAccess',
        'elasticfilesystem:DescribeMountTargets',
        'elasticfilesystem:DescribeFileSystems'
      ],
      resources: [
        `arn:aws:elasticfilesystem:${this.region}:${this.account}:file-system/${efsFileSystem.fileSystemId}`,
        `arn:aws:elasticfilesystem:${this.region}:${this.account}:access-point/${aisProxyAccessPoint.accessPointId}`
      ]
    }));

    // =================
    // DEPLOY CONTAINER SERVICES
    // =================

    const containerServices: { [key: string]: ContainerService } = {};

    // Determine container image strategy
    const usePreBuiltImages = this.node.tryGetContext('usePreBuiltImages') ?? envConfig.docker.usePreBuiltImages;

    // Deploy each enabled container
    Object.entries(envConfig.containers).forEach(([containerName, containerConfig]) => {
      if (!containerConfig.enabled) {
        return;
      }

      // Determine container image URI for dual image strategy
      let containerImageUri: string | undefined;
      if (usePreBuiltImages) {
        // Convert container name to camelCase for context variable (weather-proxy -> weatherProxy)
        const contextVarName = containerName.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase()) + 'ImageTag';
        const contextImageTag = this.node.tryGetContext(contextVarName);
        const configImageTag = containerConfig.imageTag;
        const imageTag = (contextImageTag && contextImageTag.trim() !== '') ? contextImageTag : configImageTag;
        
        if (!imageTag) {
          throw new Error(`No image tag found for container '${containerName}'. Context '${contextVarName}': ${contextImageTag}, Config: ${configImageTag}`);
        }
        
        // Get ECR repository ARN from BaseInfra and extract repository name
        const ecrRepoArn = Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.ECR_ETL_REPO));
        // Extract repository name from ARN (format: arn:aws:ecr:region:account:repository/name)
        const ecrRepoName = Fn.select(1, Fn.split('/', ecrRepoArn));
        containerImageUri = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${cdk.Token.asString(ecrRepoName)}:${imageTag}`;
      }

      // Add environment variables for S3 config access
      const environmentVariables: { [key: string]: string } = {};
      if (containerName === 'weather-proxy') {
        environmentVariables.CONFIG_BUCKET = cdk.Token.asString(Fn.select(5, Fn.split(':', configBucketArn)));
        environmentVariables.CONFIG_KEY = 'ETL-Util-Weather-Proxy-Api-Keys.json';
      } else if (containerName === 'ais-proxy') {
        environmentVariables.CONFIG_BUCKET = cdk.Token.asString(Fn.select(5, Fn.split(':', configBucketArn)));
        environmentVariables.CONFIG_KEY = 'ETL-Util-AIS-Proxy-Api-Keys.json';
      } else if (containerName === 'tileserver-gl') {
        environmentVariables.CONFIG_BUCKET = cdk.Token.asString(Fn.select(5, Fn.split(':', configBucketArn)));
        environmentVariables.CONFIG_KEY = 'ETL-Util-TileServer-GL-Api-Keys.json';
        // API keys loaded from S3 config file
      }

      // Create container service
      const containerService = new ContainerService(this, `${containerName}Service`, {
        environment,
        contextConfig: envConfig,
        containerName,
        containerConfig,
        ecsCluster,
        ecsSecurityGroup: securityGroups.ecs,
        taskRole,
        taskExecutionRole,
        containerImageUri,
        environmentVariables,
        stackNameComponent,
        efsAccessPoint: containerName === 'ais-proxy' ? aisProxyAccessPoint : undefined,
      });

      containerServices[containerName] = containerService;

      // Add ALB listener rule based on routing type
      if (containerConfig.hostname) {
        // Hostname-based routing with CloudFront
        alb.addHostnameRule(
          containerName,
          containerConfig.hostname,
          containerService.targetGroup,
          containerConfig.priority || 100
        );
        
        // Create CloudFront distribution for tileserver if enabled
        if (containerName === 'tileserver-gl' && envConfig.cloudfront?.tileserver?.enabled) {
          // Create us-east-1 certificate for CloudFront
          const cloudFrontCertificate = new acm.DnsValidatedCertificate(this, 'CloudFrontCertificate', {
            domainName: `${containerConfig.hostname}.${hostedZone.zoneName}`,
            hostedZone,
            region: 'us-east-1',
          });

          // Get API keys from CDK context
          const apiKeys = this.node.tryGetContext('apiKeys') || [
            'tk_a8b9c2d3e4f5g6h7i8j9k0l1m2n3o4p5',
            'tk_x1y2z3a4b5c6d7e8f9g0h1i2j3k4l5m6',
            'tk_q7w8e9r0t1y2u3i4o5p6a7s8d9f0g1h2',
            'tk_m3n4b5v6c7x8z9a0s1d2f3g4h5j6k7l8',
            'tk_p9o8i7u6y5t4r3e2w1q0a9s8d7f6g5h4'
          ];

          // Create CloudFront distribution
          const cloudFront = new CloudFront(this, 'TileServerCloudFront', {
            albDomainName: alb.dnsName,
            certificate: cloudFrontCertificate,
            hostedZone,
            hostname: containerConfig.hostname,
            cacheTtl: envConfig.cloudfront.tileserver.cacheTtl,
            apiKeys,
          });

          // Create Route53 records pointing to CloudFront
          new route53.ARecord(this, `${containerName}ARecord`, {
            zone: hostedZone,
            recordName: containerConfig.hostname,
            target: route53.RecordTarget.fromAlias(
              new targets.CloudFrontTarget(cloudFront.distribution)
            ),
          });

          new route53.AaaaRecord(this, `${containerName}AaaaRecord`, {
            zone: hostedZone,
            recordName: containerConfig.hostname,
            target: route53.RecordTarget.fromAlias(
              new targets.CloudFrontTarget(cloudFront.distribution)
            ),
          });

          // Output CloudFront domain
          new cdk.CfnOutput(this, 'CloudFrontDomain', {
            value: cloudFront.domainName,
            description: 'CloudFront distribution domain name',
            exportName: `${id}-CloudFrontDomain`,
          });
        } else {
          // Create Route53 record for hostname (direct ALB)
          new route53.ARecord(this, `${containerName}ARecord`, {
            zone: hostedZone,
            recordName: containerConfig.hostname,
            target: route53.RecordTarget.fromAlias(
              new route53_targets.LoadBalancerTarget(alb.loadBalancer)
            ),
          });

          new route53.AaaaRecord(this, `${containerName}AaaaRecord`, {
            zone: hostedZone,
            recordName: containerConfig.hostname,
            target: route53.RecordTarget.fromAlias(
              new route53_targets.LoadBalancerTarget(alb.loadBalancer)
            ),
          });
        }
      } else if (containerConfig.path) {
        // Path-based routing
        alb.addContainerRule(
          containerName,
          containerConfig.path,
          containerService.targetGroup,
          containerConfig.priority || 100
        );
      }
    });

    // =================
    // STACK OUTPUTS
    // =================

    // Utils URL
    new cdk.CfnOutput(this, 'UtilsUrl', {
      value: `https://${alb.utilsFqdn}`,
      description: 'ETL Utils base URL',
      exportName: `${id}-UtilsUrl`,
    });

    // Load Balancer DNS Name
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
      value: alb.dnsName,
      description: 'Application Load Balancer DNS Name',
      exportName: `${id}-LoadBalancerDnsName`,
    });

    // Container service URLs
    Object.entries(envConfig.containers).forEach(([containerName, containerConfig]) => {
      if (!containerConfig.enabled) {
        return;
      }

      let serviceUrl: string;
      if (containerConfig.hostname) {
        serviceUrl = `https://${containerConfig.hostname}.${hostedZone.zoneName}`;
      } else if (containerConfig.path) {
        serviceUrl = `https://${alb.utilsFqdn}${containerConfig.path}`;
      } else {
        return; // Skip if neither hostname nor path is defined
      }

      new cdk.CfnOutput(this, `${containerName}Url`, {
        value: serviceUrl,
        description: `${containerName} service URL`,
        exportName: `${id}-${containerName}Url`,
      });
    });

    // Utils FQDN
    new cdk.CfnOutput(this, 'UtilsFqdn', {
      value: alb.utilsFqdn,
      description: 'ETL Utils fully qualified domain name',
      exportName: `${id}-UtilsFqdn`,
    });
  }
}