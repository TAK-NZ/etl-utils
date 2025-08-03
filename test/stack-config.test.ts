import { ContextEnvironmentConfig, ContainerConfig } from '../lib/stack-config';

describe('Stack Configuration Types', () => {
  describe('ContainerConfig validation', () => {
    test('validates required properties exist', () => {
      const config: ContainerConfig = {
        enabled: true,
        path: '/weather-radar',
        healthCheckPath: '/weather-radar/health',
        port: 3000,
        cpu: 256,
        memory: 512,
        priority: 1
      };
      
      expect(typeof config.enabled).toBe('boolean');
      expect(typeof config.path).toBe('string');
      expect(typeof config.healthCheckPath).toBe('string');
      expect(typeof config.port).toBe('number');
      expect(typeof config.cpu).toBe('number');
      expect(typeof config.memory).toBe('number');
      expect(typeof config.priority).toBe('number');
    });

    test('validates path starts with slash', () => {
      const config: ContainerConfig = {
        enabled: true,
        path: '/weather-radar',
        healthCheckPath: '/weather-radar/health',
        port: 3000,
        cpu: 256,
        memory: 512,
        priority: 1
      };
      
      expect(config.path.startsWith('/')).toBe(true);
      expect(config.healthCheckPath.startsWith('/')).toBe(true);
    });
  });

  describe('ContextEnvironmentConfig validation', () => {
    test('validates complete configuration structure', () => {
      const config: ContextEnvironmentConfig = {
        stackName: 'Test',
        utilsHostname: 'utils',
        ecs: {
          taskCpu: 512,
          taskMemory: 1024,
          desiredCount: 1,
          enableDetailedLogging: true,
          enableEcsExec: true
        },
        containers: {
          'weather-proxy': {
            enabled: true,
            path: '/weather-radar',
            healthCheckPath: '/weather-radar/health',
            port: 3000,
            cpu: 256,
            memory: 512,
            priority: 1
          }
        },
        general: {
          removalPolicy: 'DESTROY',
          enableDetailedLogging: true
        },
        docker: {
          usePreBuiltImages: false,
          imageTag: 'latest'
        }
      };
      
      expect(config.stackName).toBe('Test');
      expect(config.ecs.taskCpu).toBeGreaterThan(0);
      expect(config.ecs.desiredCount).toBeGreaterThan(0);
      expect(['DESTROY', 'RETAIN'].includes(config.general.removalPolicy)).toBe(true);
    });
  });
});