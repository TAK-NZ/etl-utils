import { getEnvironmentConfig } from '../lib/stack-config';

describe('Stack Configuration', () => {
  test('returns dev-test configuration', () => {
    const config = getEnvironmentConfig('dev-test');
    
    expect(config.stackName).toBe('Dev');
    expect(config.domain).toBe('tak.nz');
    expect(config.utilsHostname).toBe('utils');
    expect(config.containers['weather-proxy']).toBeDefined();
    expect(config.containers['weather-proxy'].enabled).toBe(true);
    expect(config.containers['weather-proxy'].port).toBe(3000);
  });

  test('returns prod configuration', () => {
    const config = getEnvironmentConfig('prod');
    
    expect(config.stackName).toBe('Prod');
    expect(config.domain).toBe('tak.nz');
    expect(config.utilsHostname).toBe('utils');
    expect(config.containers['weather-proxy']).toBeDefined();
    expect(config.containers['weather-proxy'].enabled).toBe(true);
  });

  test('throws error for invalid environment', () => {
    expect(() => {
      getEnvironmentConfig('invalid' as any);
    }).toThrow('Unknown environment type: invalid');
  });

  test('weather-proxy container has correct configuration', () => {
    const config = getEnvironmentConfig('dev-test');
    const weatherProxy = config.containers['weather-proxy'];
    
    expect(weatherProxy.path).toBe('/weather-radar');
    expect(weatherProxy.healthCheckPath).toBe('/weather-radar/health');
    expect(weatherProxy.port).toBe(3000);
    expect(weatherProxy.cpu).toBe(256);
    expect(weatherProxy.memory).toBe(512);
    expect(weatherProxy.priority).toBe(1);
  });

  test('docker configuration defaults', () => {
    const config = getEnvironmentConfig('dev-test');
    
    expect(config.docker.usePreBuiltImages).toBe(false);
    expect(config.docker.imageTag).toBe('latest');
  });

  test('ECS configuration', () => {
    const devConfig = getEnvironmentConfig('dev-test');
    const prodConfig = getEnvironmentConfig('prod');
    
    expect(devConfig.ecs.desiredCount).toBe(1);
    expect(devConfig.ecs.enableEcsExec).toBe(true);
    
    expect(prodConfig.ecs.desiredCount).toBe(2);
    expect(prodConfig.ecs.enableEcsExec).toBe(false);
  });
});