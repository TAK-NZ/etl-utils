# ETL Utils Infrastructure

<p align='center'>Utilities to support other ETLs</p>

## Overview

This CDK stack deploys containerized utility services to the existing TAK infrastructure, providing a scalable platform for various data processing tools in support of ETLs.

## Architecture

- **Application Load Balancer (ALB)** - Routes traffic to different services based on path
- **ECS Fargate Services** - Individual container services for each utility
- **Route53 DNS** - `utils.{domain}` hostname with IPv4/IPv6 support
- **Security Groups** - Network security for ALB and ECS tasks
- **Auto Scaling** - Production environment auto-scaling based on CPU/memory

## Services

### weather-proxy
Weather radar proxy service providing access to real-time radar data from [Rain Viewer](https://www.rainviewer.com/api.html).

- **Path**: `/weather-radar/*`
- **Health Check**: `/weather-radar/health`
- **Documentation**: [Weather Proxy API](docs/WEATHER_PROXY.md)

### ais-proxy
AISHub-compatible proxy service providing access to real-time AIS vessel data from AISStream with enhanced Class B vessel name lookup.

- **Path**: `/ais-proxy/*`
- **Health Check**: `/ais-proxy/health`
- **Documentation**: [AIS Proxy API](docs/AIS_PROXY.md)

### tileserver-gl
MapTiler TileServer GL providing vector and raster tile services for New Zealand topographic maps with API key authentication.

- **Hostname**: `tiles.{domain}`
- **Health Check**: `/health`
- **Authentication**: API key required for `/styles/*` paths via `?api=your-key` parameter
- **Documentation**: [TileServer GL API](docs/TILESERVER_GL.md)
- **CloudFront CDN**: [CloudFront Setup](docs/CLOUDFRONT.md) with edge authentication
- **API Keys**: Managed via CDK context or fallback defaults



## Configuration

Environment-specific configuration is managed in `cdk.json`:

```json
{
  "dev-test": {
    "stackName": "Dev",
    "utilsHostname": "utils",
    "containers": {
      "weather-proxy": {
        "enabled": true,
        "path": "/weather-radar",
        "port": 3000,
        "priority": 1
      },
      "ais-proxy": {
        "enabled": true,
        "path": "/ais-proxy",
        "port": 3000,
        "priority": 2
      },
      "tileserver-gl": {
        "enabled": true,
        "hostname": "tiles",
        "port": 8080,
        "priority": 3
      }
    }
  }
}
```

## Deployment Strategy

Following the TAK-NZ pattern, this stack supports both local Docker builds and pre-built ECR images:

- **Development**: Uses local Docker builds from container folders
- **Production**: Uses pre-built images from ECR with tags
- **CloudFront**: Optional CDN for tileserver with global performance benefits

## Prerequisites

1. Base infrastructure must be deployed (`base-infra` stack)
2. Node.js and AWS CDK installed
3. AWS credentials configured
4. API keys configured via CDK context (see [API Keys Setup](#api-keys-setup))

## Deployment

```bash
# Install dependencies
npm install

# Deploy to dev-test environment
npm run deploy

# Deploy to production
cdk deploy --context envType=prod

# Deploy with custom API keys
cdk deploy --context envType=dev-test --context apiKeys='["key1","key2"]'

# Deploy with pre-built images (new JSON format - recommended)
cdk deploy --context envType=prod --context usePreBuiltImages=true --context imageTagsJson='{"weather-proxy":"v1.0.0","ais-proxy":"v1.0.0","tileserver-gl":"v1.0.0"}'

# Deploy with pre-built images (legacy individual parameters - still supported)
cdk deploy --context envType=prod --context usePreBuiltImages=true --context weatherProxyImageTag=v1.0.0 --context aisProxyImageTag=v1.0.0 --context tileserverGlImageTag=v1.0.0
```

## Adding New Services

1. Create a new folder for your service (e.g., `my-service/`)
2. Add Dockerfile and application code
3. Update `cdk.json` to include the new container configuration
4. Deploy the stack

**Note**: CI/CD workflows automatically discover and build new containers from `cdk.json` - no manual workflow updates required!

Example container configuration:
```json
"my-service": {
  "enabled": true,
  "path": "/my-service",
  "healthCheckPath": "/my-service/health",
  "port": 8080,
  "cpu": 256,
  "memory": 512,
  "priority": 3
}
```

## Infrastructure Dependencies

This stack imports resources from the base infrastructure:

- **VPC and Subnets** - Network infrastructure
- **ECS Cluster** - Container orchestration
- **SSL Certificate** - HTTPS termination
- **Route53 Hosted Zone** - DNS management
- **ECR Repository** - Container image storage
- **S3 Bucket** - Configuration and logs storage

## Monitoring

- **CloudWatch Logs** - Container logs with configurable retention
- **ALB Access Logs** - Stored in S3 bucket from base infrastructure
- **ECS Service Metrics** - CPU, memory, and task count metrics
- **Health Checks** - ALB and ECS health monitoring

## Security

- **Security Groups** - Restrict traffic between ALB and ECS tasks
- **Private Subnets** - ECS tasks deployed in private subnets
- **IAM Roles** - Least privilege access for ECS tasks
- **HTTPS Only** - HTTP traffic redirected to HTTPS
- **CloudFront** - Additional SSL termination and DDoS protection

## Auto Scaling (Production)

Production environment includes auto scaling based on:
- **CPU Utilization** - Target 70%
- **Memory Utilization** - Target 80%
- **Scale Range** - 1-5 tasks per service

## API Keys Setup

### Option 1: CDK Context (Recommended)
```bash
# Deploy with custom API keys
cdk deploy --context apiKeys='["your-key-1","your-key-2"]'
```

### Option 2: GitHub Actions (CI/CD)
Set `TILESERVER_API_KEYS` secret in GitHub repository settings:
```json
["your-key-1","your-key-2"]
```

### Option 3: Default Keys
If no context is provided, uses these default keys:
- `tk_a8b9c2d3e4f5g6h7i8j9k0l1m2n3o4p5`
- `tk_x1y2z3a4b5c6d7e8f9g0h1i2j3k4l5m6`
- `tk_q7w8e9r0t1y2u3i4o5p6a7s8d9f0g1h2`
- `tk_m3n4b5v6c7x8z9a0s1d2f3g4h5j6k7l8`
- `tk_p9o8i7u6y5t4r3e2w1q0a9s8d7f6g5h4`

### Test API Authentication
```bash
# Edit test script with your domain and API key
./tileserver-helper/test-api-auth.sh
```

## Testing

```bash
# Run unit tests
npm test

# Run tests with coverage
npm run test:coverage

# Test API key authentication
./tileserver-helper/test-api-auth.sh

# Test with custom API keys and image tags
cdk deploy --context apiKeys='["test-key"]' --context imageTagsJson='{"weather-proxy":"test-v1.0.0"}'

# GitHub Actions deployment uses TILESERVER_API_KEYS secret and imageTagsJson automatically
```

## Development

```bash
# Build TypeScript
npm run build

# Watch for changes
npm run watch

# View CloudFormation diff
npm run diff
```