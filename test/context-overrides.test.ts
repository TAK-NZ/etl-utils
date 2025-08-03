import * as cdk from 'aws-cdk-lib';
import { applyContextOverrides } from '../lib/utils/context-overrides';
import { ContextEnvironmentConfig } from '../lib/stack-config';

describe('Context Overrides', () => {
  let app: cdk.App;
  let baseConfig: ContextEnvironmentConfig;

  beforeEach(() => {
    app = new cdk.App();
    baseConfig = {
      stackName: 'Test',
      utilsHostname: 'utils',
      ecs: {
        taskCpu: 512,
        taskMemory: 1024,
        desiredCount: 1,
        enableDetailedLogging: true,
        enableEcsExec: true
      },
      containers: {},
      general: {
        removalPolicy: 'DESTROY',
        enableDetailedLogging: true
      },
      docker: {
        usePreBuiltImages: false,
        imageTag: 'latest'
      }
    };
  });

  test('returns base config when no overrides provided', () => {
    const result = applyContextOverrides(app, baseConfig);
    expect(result).toEqual(baseConfig);
  });

  test('overrides stackName from context', () => {
    app.node.setContext('stackName', 'Override');
    const result = applyContextOverrides(app, baseConfig);
    expect(result.stackName).toBe('Override');
  });

  test('overrides utilsHostname from context', () => {
    app.node.setContext('utilsHostname', 'test-utils');
    const result = applyContextOverrides(app, baseConfig);
    expect(result.utilsHostname).toBe('test-utils');
  });

  test('overrides ECS configuration from context', () => {
    app.node.setContext('taskCpu', '1024');
    app.node.setContext('taskMemory', '2048');
    app.node.setContext('desiredCount', '2');
    
    const result = applyContextOverrides(app, baseConfig);
    
    expect(result.ecs.taskCpu).toBe(1024);
    expect(result.ecs.taskMemory).toBe(2048);
    expect(result.ecs.desiredCount).toBe(2);
  });

  test('overrides boolean values from string context', () => {
    app.node.setContext('enableDetailedLogging', 'false');
    app.node.setContext('enableEcsExec', 'false');
    app.node.setContext('usePreBuiltImages', 'true');
    
    const result = applyContextOverrides(app, baseConfig);
    
    expect(result.ecs.enableDetailedLogging).toBe(false);
    expect(result.ecs.enableEcsExec).toBe(false);
    expect(result.docker.usePreBuiltImages).toBe(true);
  });

  test('handles invalid number context values', () => {
    app.node.setContext('taskCpu', 'invalid');
    app.node.setContext('desiredCount', 'not-a-number');
    
    const result = applyContextOverrides(app, baseConfig);
    
    expect(result.ecs.taskCpu).toBe(baseConfig.ecs.taskCpu);
    expect(result.ecs.desiredCount).toBe(baseConfig.ecs.desiredCount);
  });

  test('handles invalid boolean context values', () => {
    app.node.setContext('enableEcsExec', 'invalid');
    
    const result = applyContextOverrides(app, baseConfig);
    
    // Invalid string values are parsed as false by the string parsing logic
    expect(result.ecs.enableEcsExec).toBe(false);
  });

  test('handles non-string non-boolean context values', () => {
    app.node.setContext('enableEcsExec', 123);
    
    const result = applyContextOverrides(app, baseConfig);
    
    // Non-string, non-boolean values return undefined, so fallback to base config
    expect(result.ecs.enableEcsExec).toBe(baseConfig.ecs.enableEcsExec);
  });

  test('overrides docker configuration', () => {
    app.node.setContext('imageTag', 'v1.2.3');
    app.node.setContext('removalPolicy', 'RETAIN');
    
    const result = applyContextOverrides(app, baseConfig);
    
    expect(result.docker.imageTag).toBe('v1.2.3');
    expect(result.general.removalPolicy).toBe('RETAIN');
  });
});