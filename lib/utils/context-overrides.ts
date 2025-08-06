/**
 * Dynamic context override utilities for ETL Utils
 */

import * as cdk from 'aws-cdk-lib';
import { ContextEnvironmentConfig } from '../stack-config';

export function applyContextOverrides(
  app: cdk.App, 
  baseConfig: ContextEnvironmentConfig
): ContextEnvironmentConfig {
  const topLevelOverrides = {
    stackName: app.node.tryGetContext('stackName'),
    utilsHostname: app.node.tryGetContext('utilsHostname'),
  };

  return {
    ...baseConfig,
    ...Object.fromEntries(Object.entries(topLevelOverrides).filter(([_, v]) => v !== undefined)),
    ecs: {
      ...baseConfig.ecs,
      taskCpu: parseContextNumber(app.node.tryGetContext('taskCpu')) ?? baseConfig.ecs.taskCpu,
      taskMemory: parseContextNumber(app.node.tryGetContext('taskMemory')) ?? baseConfig.ecs.taskMemory,
      desiredCount: parseContextNumber(app.node.tryGetContext('desiredCount')) ?? baseConfig.ecs.desiredCount,
      enableDetailedLogging: parseContextBoolean(app.node.tryGetContext('enableDetailedLogging')) ?? baseConfig.ecs.enableDetailedLogging,
      enableEcsExec: parseContextBoolean(app.node.tryGetContext('enableEcsExec')) ?? baseConfig.ecs.enableEcsExec,
    },
    general: {
      ...baseConfig.general,
      removalPolicy: app.node.tryGetContext('removalPolicy') || baseConfig.general.removalPolicy,
      enableDetailedLogging: parseContextBoolean(app.node.tryGetContext('enableDetailedLogging')) ?? baseConfig.general.enableDetailedLogging,
    },
    docker: {
      ...baseConfig.docker,
      usePreBuiltImages: parseContextBoolean(app.node.tryGetContext('usePreBuiltImages')) ?? baseConfig.docker.usePreBuiltImages,

    },
  };
}

/**
 * Parse context value to number, handling string inputs from CLI
 */
function parseContextNumber(value: any): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'string' ? parseInt(value, 10) : value;
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Parse context value to boolean, handling string inputs from CLI
 */
function parseContextBoolean(value: any): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return undefined;
}