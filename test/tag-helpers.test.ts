import { generateStandardTags, TagDefaults } from '../lib/utils/tag-helpers';
import { ContextEnvironmentConfig } from '../lib/stack-config';

describe('Tag Helpers', () => {
  let envConfig: ContextEnvironmentConfig;

  beforeEach(() => {
    envConfig = {
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

  test('generates standard tags with defaults', () => {
    const tags = generateStandardTags(envConfig, 'dev-test');
    
    expect(tags).toEqual({
      Project: 'TAK.NZ',
      Environment: 'Test',
      Component: 'EtlUtils',
      ManagedBy: 'CDK',
      'Environment Type': 'Dev-Test'
    });
  });

  test('generates standard tags for production environment', () => {
    const tags = generateStandardTags(envConfig, 'prod');
    
    expect(tags['Environment Type']).toBe('Prod');
  });

  test('uses custom defaults when provided', () => {
    const defaults: TagDefaults = {
      project: 'Custom Project',
      component: 'CustomComponent',
      region: 'us-west-2'
    };
    
    const tags = generateStandardTags(envConfig, 'dev-test', defaults);
    
    expect(tags.Project).toBe('Custom Project');
    expect(tags.Component).toBe('CustomComponent');
  });

  test('uses environment stackName for Environment tag', () => {
    envConfig.stackName = 'Production';
    
    const tags = generateStandardTags(envConfig, 'prod');
    
    expect(tags.Environment).toBe('Production');
  });

  test('handles different environment types correctly', () => {
    const devTags = generateStandardTags(envConfig, 'dev-test');
    const prodTags = generateStandardTags(envConfig, 'prod');
    
    expect(devTags['Environment Type']).toBe('Dev-Test');
    expect(prodTags['Environment Type']).toBe('Prod');
  });
});