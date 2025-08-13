/**
 * Configuration interface for EtlUtils stack template
 * This makes the stack reusable across different projects and environments
 */

/**
 * Container configuration for individual services
 */
export interface ContainerConfig {
  enabled: boolean;
  path?: string;
  hostname?: string;
  healthCheckPath: string;
  port: number;
  cpu: number;
  memory: number;
  priority?: number;
  imageTag: string;
}

/**
 * Context-based configuration interface matching cdk.context.json structure
 */
export interface ContextEnvironmentConfig {
  stackName: string;
  utilsHostname: string;
  ecs: {
    taskCpu: number;
    taskMemory: number;
    desiredCount: number;
    enableDetailedLogging: boolean;
    enableEcsExec: boolean;
  };
  containers: {
    [key: string]: ContainerConfig;
  };
  general: {
    removalPolicy: string;
    enableDetailedLogging: boolean;
  };
  docker: {
    usePreBuiltImages: boolean;
  };
  cloudfront?: {
    tileserver?: {
      enabled: boolean;
      cacheTtl?: {
        tiles?: string;
        metadata?: string;
        health?: string;
      };
    };
  };
}