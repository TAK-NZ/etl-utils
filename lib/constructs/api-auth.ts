/**
 * API Authentication Construct - S3 config for API key management
 */
import { Construct } from 'constructs';
import {
  aws_elasticloadbalancingv2 as elbv2,
} from 'aws-cdk-lib';
import type { ContextEnvironmentConfig } from '../stack-config';

export interface ApiAuthProps {
  environment: 'prod' | 'dev-test';
  contextConfig: ContextEnvironmentConfig;
}

export class ApiAuth extends Construct {
  constructor(scope: Construct, id: string, props: ApiAuthProps) {
    super(scope, id);
    // API keys managed via S3 config bucket
  }

  /**
   * Create regular listener rule (authentication handled by nginx sidecar)
   */
  public createAuthenticatedRule(
    id: string,
    listener: elbv2.ApplicationListener,
    hostname: string,
    targetGroup: elbv2.ApplicationTargetGroup,
    priority: number
  ): elbv2.ApplicationListenerRule {
    return new elbv2.ApplicationListenerRule(this, `${id}AuthRule`, {
      listener,
      priority,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([hostname]),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });
  }
}