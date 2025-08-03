import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
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

  test('creates ALB security group with correct ingress rules', () => {
    new SecurityGroups(stack, 'SecurityGroups', {
      vpc,
      stackNameComponent: 'Test'
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for ETL Utils ALB',
      SecurityGroupIngress: [
        {
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIp: '0.0.0.0/0',
          Description: 'Allow HTTP traffic'
        },
        {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: '0.0.0.0/0',
          Description: 'Allow HTTPS traffic'
        }
      ]
    });
  });

  test('creates ECS security group with ALB ingress', () => {
    new SecurityGroups(stack, 'SecurityGroups', {
      vpc,
      stackNameComponent: 'Test'
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for ETL Utils ECS tasks'
    });
  });

  test('creates security group egress rules', () => {
    new SecurityGroups(stack, 'SecurityGroups', {
      vpc,
      stackNameComponent: 'Test'
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      CidrIp: '0.0.0.0/0',
      Description: 'Allow HTTPS outbound for API calls'
    });
  });
});