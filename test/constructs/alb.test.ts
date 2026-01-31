import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Alb } from '../../lib/constructs/alb';
import { createTestApp, mockCloudFormationImports } from '../utils';

describe('Alb Construct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let vpc: ec2.IVpc;
  let certificate: acm.ICertificate;
  let hostedZone: route53.IHostedZone;
  let albSecurityGroup: ec2.ISecurityGroup;

  beforeEach(() => {
    app = createTestApp();
    mockCloudFormationImports(app);
    stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'ap-southeast-2' }
    });
    
    vpc = new ec2.Vpc(stack, 'TestVpc');
    certificate = acm.Certificate.fromCertificateArn(stack, 'TestCert', 
      'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012');
    hostedZone = route53.HostedZone.fromHostedZoneAttributes(stack, 'TestZone', {
      hostedZoneId: 'Z1PA6795UKMFR9',
      zoneName: 'dev.tak.nz'
    });
    albSecurityGroup = new ec2.SecurityGroup(stack, 'TestAlbSg', { vpc });
  });

  it('creates application load balancer with correct configuration', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    const alb = new Alb(stack, 'Alb', {
      environment: 'dev-test',
      contextConfig: envConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup,
    });

    const template = Template.fromStack(stack);

    // Check ALB creation
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Name: 'utils-infra-dev',
      Type: 'application',
      Scheme: 'internet-facing',
      IpAddressType: 'dualstack',
    });

    expect(alb.loadBalancer).toBeDefined();
    expect(alb.utilsFqdn).toBe('utils.dev.tak.nz');
  });

  it('creates HTTPS listener with certificate', () => {
    const envConfig = app.node.tryGetContext('prod');
    
    new Alb(stack, 'Alb', {
      environment: 'prod',
      contextConfig: envConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup,
    });

    const template = Template.fromStack(stack);

    // Check HTTPS listener
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });
  });

  it('creates HTTP to HTTPS redirect listener', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    new Alb(stack, 'Alb', {
      environment: 'dev-test',
      contextConfig: envConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup,
    });

    const template = Template.fromStack(stack);

    // Check HTTP listener with redirect
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [{
        Type: 'redirect',
        RedirectConfig: {
          Protocol: 'HTTPS',
          Port: '443',
          StatusCode: 'HTTP_301'
        }
      }]
    });
  });

  it('creates default target group with health check', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    new Alb(stack, 'Alb', {
      environment: 'dev-test',
      contextConfig: envConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup,
    });

    const template = Template.fromStack(stack);

    // Check default target group
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'utils-infra-dev-default',
      Port: 80,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/weather-radar/health',
    });
  });

  it('creates Route53 A and AAAA records', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    new Alb(stack, 'Alb', {
      environment: 'dev-test',
      contextConfig: envConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup,
    });

    const template = Template.fromStack(stack);

    // Check A record exists
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A'
    });

    // Check AAAA record exists
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'AAAA'
    });
  });

  it('adds container rule correctly', () => {
    const envConfig = app.node.tryGetContext('dev-test');
    
    const alb = new Alb(stack, 'Alb', {
      environment: 'dev-test',
      contextConfig: envConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup,
    });

    // Create a mock target group
    const targetGroup = new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(stack, 'TestTg', {
      vpc,
      targetType: cdk.aws_elasticloadbalancingv2.TargetType.IP,
      port: 3000,
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
    });

    const rule = alb.addContainerRule('weather-proxy', '/weather-radar', targetGroup, 1);

    expect(rule).toBeDefined();

    const template = Template.fromStack(stack);

    // Check listener rule exists
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 1,
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern'
        })
      ])
    });
  });

  it('configures access logging to S3', () => {
    const envConfig = app.node.tryGetContext('prod');
    
    new Alb(stack, 'Alb', {
      environment: 'prod',
      contextConfig: envConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup,
    });

    const template = Template.fromStack(stack);

    // Check ALB attributes for access logging
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        { Key: 'access_logs.s3.prefix', Value: 'TAK-Prod-UtilsInfra' }
      ])
    });
  });

  it('uses correct naming for different environments', () => {
    const prodConfig = app.node.tryGetContext('prod');
    
    new Alb(stack, 'ProdAlb', {
      environment: 'prod',
      contextConfig: prodConfig,
      vpc,
      certificate,
      hostedZone,
      albSecurityGroup,
    });

    const template = Template.fromStack(stack);

    // Check production naming
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Name: 'utils-infra-prod',
    });

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Name: 'utils-infra-prod-default',
    });
  });
});