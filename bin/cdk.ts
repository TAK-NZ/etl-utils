#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { UtilsInfraStack } from '../lib/utils-infra-stack';
import { ContextEnvironmentConfig } from '../lib/stack-config';
import { DEFAULT_AWS_REGION } from '../lib/utils/constants';
import { generateStandardTags } from '../lib/utils/tag-helpers';
import { applyContextOverrides } from '../lib/utils/context-overrides';

const app = new cdk.App();

// Get environment from context (defaults to dev-test)
const envName = app.node.tryGetContext('envType') || 'dev-test';

// Validate environment
if (!['prod', 'dev-test'].includes(envName)) {
  throw new Error(`Invalid environment: ${envName}. Must be 'prod' or 'dev-test'`);
}

// Get environment configuration from context
const envConfig: ContextEnvironmentConfig = app.node.tryGetContext(envName);
if (!envConfig) {
  throw new Error(`No configuration found for environment: ${envName}`);
}

// Get defaults with context overrides
const defaults = {
  project: app.node.tryGetContext('tak-project') || app.node.tryGetContext('utils-infra-defaults')?.project,
  component: app.node.tryGetContext('tak-component') || app.node.tryGetContext('utils-infra-defaults')?.component,
  region: app.node.tryGetContext('tak-region') || app.node.tryGetContext('utils-infra-defaults')?.region
};

// Apply context overrides for command-line parameter support
const finalEnvConfig = applyContextOverrides(app, envConfig);

// Create stack name
const stackName = `TAK-${finalEnvConfig.stackName}-UtilsInfra`;

// Create the stack
new UtilsInfraStack(app, stackName, {
  environment: envName as 'prod' | 'dev-test',
  envConfig: finalEnvConfig,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || defaults?.region || DEFAULT_AWS_REGION,
  },
  tags: generateStandardTags(finalEnvConfig, envName as 'prod' | 'dev-test', defaults),
});