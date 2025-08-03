/**
 * Security Groups Construct - Network security for ETL Utils services
 */
import { Construct } from 'constructs';
import { aws_ec2 as ec2 } from 'aws-cdk-lib';

/**
 * Properties for the SecurityGroups construct
 */
export interface SecurityGroupsProps {
  /**
   * VPC for deployment
   */
  vpc: ec2.IVpc;

  /**
   * Stack name component for naming
   */
  stackNameComponent: string;
}

/**
 * CDK construct for security groups used by ETL Utils services
 */
export class SecurityGroups extends Construct {
  /**
   * Security group for ALB
   */
  public readonly alb: ec2.SecurityGroup;

  /**
   * Security group for ECS tasks
   */
  public readonly ecs: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SecurityGroupsProps) {
    super(scope, id);

    const { vpc, stackNameComponent } = props;

    // ALB Security Group
    this.alb = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      securityGroupName: `etl-utils-${stackNameComponent.toLowerCase()}-alb`,
      description: 'Security group for ETL Utils Application Load Balancer',
      allowAllOutbound: true,
    });

    // Allow HTTP and HTTPS traffic from anywhere
    this.alb.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from anywhere'
    );

    this.alb.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from anywhere'
    );

    // Allow IPv6 traffic
    this.alb.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from anywhere (IPv6)'
    );

    this.alb.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from anywhere (IPv6)'
    );

    // ECS Security Group
    this.ecs = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      securityGroupName: `etl-utils-${stackNameComponent.toLowerCase()}-ecs`,
      description: 'Security group for ETL Utils ECS tasks',
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });

    // Allow traffic from ALB to ECS tasks on dynamic ports
    this.ecs.addIngressRule(
      this.alb,
      ec2.Port.tcpRange(32768, 65535),
      'Allow traffic from ALB on dynamic ports'
    );

    // Allow specific container ports from ALB
    this.ecs.addIngressRule(
      this.alb,
      ec2.Port.tcp(3000),
      'Allow traffic from ALB on port 3000'
    );

    this.ecs.addIngressRule(
      this.alb,
      ec2.Port.tcp(8080),
      'Allow traffic from ALB on port 8080'
    );
  }
}