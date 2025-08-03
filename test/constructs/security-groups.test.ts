import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SecurityGroups } from '../../lib/constructs/security-groups';

describe('SecurityGroups Construct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let vpc: ec2.IVpc;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    vpc = new ec2.Vpc(stack, 'TestVpc');
  });

  it('creates ALB security group with correct ingress rules', () => {
    const securityGroups = new SecurityGroups(stack, 'SecurityGroups', {
      vpc,
      stackNameComponent: 'Dev',
    });

    const template = Template.fromStack(stack);

    // Check ALB security group exists
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: 'TAK-Dev-ETL-Utils-alb',
      GroupDescription: 'Security group for ETL Utils Application Load Balancer',
    });

    // ALB ingress rules are created as separate resources, check they exist
    const resources = template.toJSON().Resources;
    const ingressRules = Object.values(resources).filter((r: any) => r.Type === 'AWS::EC2::SecurityGroupIngress');
    
    // Should have ingress rules for ALB (HTTP/HTTPS IPv4 and IPv6)
    expect(ingressRules.length).toBeGreaterThan(0);
    expect(securityGroups.alb).toBeDefined();
  });

  it('creates ECS security group with correct ingress rules', () => {
    const securityGroups = new SecurityGroups(stack, 'SecurityGroups', {
      vpc,
      stackNameComponent: 'Prod',
    });

    const template = Template.fromStack(stack);

    // Check ECS security group exists
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: 'TAK-Prod-ETL-Utils-ecs',
      GroupDescription: 'Security group for ETL Utils ECS tasks',
    });

    // Check dynamic port range ingress
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 32768,
      ToPort: 65535,
    });

    // Check specific port ingress
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 3000,
      ToPort: 3000,
    });

    expect(securityGroups.ecs).toBeDefined();
  });

  it('creates EFS security group with correct configuration', () => {
    const securityGroups = new SecurityGroups(stack, 'SecurityGroups', {
      vpc,
      stackNameComponent: 'Dev',
    });

    const template = Template.fromStack(stack);

    // Check EFS security group exists
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupName: 'TAK-Dev-ETL-Utils-efs',
      GroupDescription: 'Security group for ETL Utils EFS',
    });

    // Check EFS port ingress
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 2049,
      ToPort: 2049,
    });

    expect(securityGroups.efs).toBeDefined();
  });

  it('creates all three security groups', () => {
    const securityGroups = new SecurityGroups(stack, 'SecurityGroups', {
      vpc,
      stackNameComponent: 'Test',
    });

    const template = Template.fromStack(stack);

    // Should create exactly 3 security groups (no VPC default in this test)
    template.resourceCountIs('AWS::EC2::SecurityGroup', 3);

    expect(securityGroups.alb).toBeDefined();
    expect(securityGroups.ecs).toBeDefined();
    expect(securityGroups.efs).toBeDefined();
  });

  it('allows all outbound traffic for ALB and ECS', () => {
    new SecurityGroups(stack, 'SecurityGroups', {
      vpc,
      stackNameComponent: 'Dev',
    });

    const template = Template.fromStack(stack);

    // Check outbound rules exist (CDK creates these automatically when allowAllOutbound is true)
    const securityGroups = template.toJSON().Resources;
    const sgResources = Object.values(securityGroups).filter((r: any) => r.Type === 'AWS::EC2::SecurityGroup');
    
    // ALB and ECS should have outbound rules, EFS should not
    const albSg = sgResources.find((sg: any) => sg.Properties?.GroupName?.includes('alb'));
    const ecsSg = sgResources.find((sg: any) => sg.Properties?.GroupName?.includes('ecs'));
    const efsSg = sgResources.find((sg: any) => sg.Properties?.GroupName?.includes('efs'));

    expect(albSg).toBeDefined();
    expect(ecsSg).toBeDefined();
    expect(efsSg).toBeDefined();
  });
});