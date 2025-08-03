import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Template } from 'aws-cdk-lib/assertions';
import { Alb } from '../../lib/constructs/alb';
import { ContextEnvironmentConfig } from '../../lib/stack-config';

describe('ALB Construct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let vpc: ec2.IVpc;
  let certificate: acm.ICertificate;
  let hostedZone: route53.IHostedZone;
  let albSecurityGroup: ec2.ISecurityGroup;
  let mockConfig: ContextEnvironmentConfig;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    vpc = new ec2.Vpc(stack, 'TestVpc');
    certificate = acm.Certificate.fromCertificateArn(stack, 'TestCert', 'arn:aws:acm:us-east-1:123456789012:certificate/test');
    hostedZone = route53.HostedZone.fromHostedZoneAttributes(stack, 'TestZone', {
      hostedZoneId: 'Z123456789',
      zoneName: 'test.tak.nz'
    });
    albSecurityGroup = new ec2.SecurityGroup(stack, 'TestSG', { vpc });
    
    mockConfig = {
      stackName: 'Test',
      domain: 'test.tak.nz',
      utilsHostname: 'utils',
      general: { removalPolicy: 'DESTROY' },
      ecs: { desiredCount: 1, enableEcsExec: true },
      docker: { usePreBuiltImages: false, imageTag: 'latest' },
      containers: {}
    };
  });

  test('creates application load balancer', () => {
    new Alb(stack, 'TestAlb', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'application',
      Scheme: 'internet-facing'
    });
  });

  test('creates HTTPS listener with certificate', () => {
    new Alb(stack, 'TestAlb', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS'
    });
  });

  test('creates HTTP redirect listener', () => {
    new Alb(stack, 'TestAlb', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP'
    });
  });

  test('creates Route53 A record', () => {
    new Alb(stack, 'TestAlb', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'utils.test.tak.nz.'
    });
  });

  test('creates Route53 AAAA record for IPv6', () => {
    new Alb(stack, 'TestAlb', {
      environment: 'dev-test',
      contextConfig: mockConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA',
      Name: 'utils.test.tak.nz.'
    });
  });
});