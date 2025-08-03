import { ContextEnvironmentConfig, ContainerConfig } from '../lib/stack-config';

describe('Stack Configuration Types', () => {
  describe('ContainerConfig interface', () => {
    it('should define all required properties', () => {
      const containerConfig: ContainerConfig = {
        enabled: true,
        path: '/test-path',
        healthCheckPath: '/test-path/health',
        port: 3000,
        cpu: 256,
        memory: 512,
        priority: 1
      };

      expect(containerConfig.enabled).toBe(true);
      expect(containerConfig.path).toBe('/test-path');
      expect(containerConfig.healthCheckPath).toBe('/test-path/health');
      expect(containerConfig.port).toBe(3000);
      expect(containerConfig.cpu).toBe(256);
      expect(containerConfig.memory).toBe(512);
      expect(containerConfig.priority).toBe(1);
    });

    it('should allow disabled containers', () => {
      const containerConfig: ContainerConfig = {
        enabled: false,
        path: '/disabled',
        healthCheckPath: '/disabled/health',
        port: 8080,
        cpu: 128,
        memory: 256,
        priority: 10
      };

      expect(containerConfig.enabled).toBe(false);
    });

    it('should validate property types', () => {
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
  });

  describe('ContextEnvironmentConfig interface', () => {
    it('should define all required properties', () => {
      const envConfig: ContextEnvironmentConfig = {
        stackName: 'Test',
        utilsHostname: 'utils',
        ecs: {
          taskCpu: 512,
          taskMemory: 1024,
          desiredCount: 1,
          enableDetailedLogging: true,
          enableEcsExec: false
        },
        containers: {
          'test-container': {
            enabled: true,
            path: '/test',
            healthCheckPath: '/test/health',
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

      expect(envConfig.stackName).toBe('Test');
      expect(envConfig.utilsHostname).toBe('utils');
      expect(envConfig.ecs.taskCpu).toBe(512);
      expect(envConfig.ecs.taskMemory).toBe(1024);
      expect(envConfig.ecs.desiredCount).toBe(1);
      expect(envConfig.ecs.enableDetailedLogging).toBe(true);
      expect(envConfig.ecs.enableEcsExec).toBe(false);
      expect(envConfig.containers['test-container'].enabled).toBe(true);
      expect(envConfig.general.removalPolicy).toBe('DESTROY');
      expect(envConfig.docker.usePreBuiltImages).toBe(false);
    });

    it('should support multiple containers', () => {
      const envConfig: ContextEnvironmentConfig = {
        stackName: 'Multi',
        utilsHostname: 'utils',
        ecs: {
          taskCpu: 1024,
          taskMemory: 2048,
          desiredCount: 2,
          enableDetailedLogging: false,
          enableEcsExec: true
        },
        containers: {
          'container-1': {
            enabled: true,
            path: '/api1',
            healthCheckPath: '/api1/health',
            port: 3000,
            cpu: 512,
            memory: 1024,
            priority: 1
          },
          'container-2': {
            enabled: false,
            path: '/api2',
            healthCheckPath: '/api2/health',
            port: 4000,
            cpu: 256,
            memory: 512,
            priority: 2
          }
        },
        general: {
          removalPolicy: 'RETAIN',
          enableDetailedLogging: false
        },
        docker: {
          usePreBuiltImages: true,
          imageTag: 'v1.2.3'
        }
      };

      expect(Object.keys(envConfig.containers)).toHaveLength(2);
      expect(envConfig.containers['container-1'].enabled).toBe(true);
      expect(envConfig.containers['container-2'].enabled).toBe(false);
    });

    it('should validate configuration structure', () => {
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