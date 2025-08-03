import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StackProps, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as iam from 'aws-cdk-lib/aws-iam';

// Construct imports
import { SecurityGroups } from './constructs/security-groups';
import { Alb } from './constructs/alb';
import { ContainerService } from './constructs/container-service';

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
      roleName: `etl-utils-${stackNameComponent.toLowerCase()}-task-execution`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Task role
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `etl-utils-${stackNameComponent.toLowerCase()}-task`,
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
        const imageTag = this.node.tryGetContext(`${containerName}ImageTag`) ?? envConfig.docker.imageTag;
        // Get ECR repository ARN from BaseInfra and extract repository name
        const ecrRepoArn = Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.ECR_ETL_REPO));
        // Extract repository name from ARN (format: arn:aws:ecr:region:account:repository/name)
        const ecrRepoName = Fn.select(1, Fn.split('/', ecrRepoArn));
        containerImageUri = `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${cdk.Token.asString(ecrRepoName)}:${containerName}-${imageTag}`;
      }

      // Add environment variables for S3 config access
      const environmentVariables: { [key: string]: string } = {};
      if (containerName === 'weather-proxy') {
        environmentVariables.CONFIG_BUCKET = cdk.Token.asString(Fn.select(5, Fn.split(':', configBucketArn)));
        environmentVariables.CONFIG_KEY = 'ETL-Util-Weather-Proxy-Api-Keys.json';
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
      });

      containerServices[containerName] = containerService;

      // Add ALB listener rule
      alb.addContainerRule(
        containerName,
        containerConfig.path,
        containerService.targetGroup,
        containerConfig.priority
      );
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

      new cdk.CfnOutput(this, `${containerName}Url`, {
        value: `https://${alb.utilsFqdn}${containerConfig.path}`,
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