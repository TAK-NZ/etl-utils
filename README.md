# ETL Utils Infrastructure

CDK Infrastructure for deploying multiple Docker containers to an existing ECS Fargate service, fronted by an Application Load Balancer.

## Architecture

This CDK stack deploys multiple containerized services to the existing TAK infrastructure:

- **Application Load Balancer (ALB)** - Routes traffic to different services based on path
- **ECS Fargate Services** - Individual container services for each utility
- **Route53 DNS** - `utils.{domain}` hostname with IPv4/IPv6 support
- **Security Groups** - Network security for ALB and ECS tasks
- **Auto Scaling** - Production environment auto-scaling based on CPU/memory

## Container Services

Each container service is managed in its own folder:

### weather-proxy
- **Path**: `/weather-radar/*`
- **Port**: 3000
- **Health Check**: `/weather-radar/health`
- **Description**: Weather radar proxy service

## Weather Radar API Usage

The weather-proxy service provides access to real-time weather radar data from RainViewer.

### Base URL
```
https://utils.{domain}/weather-radar/
```

### Endpoints

#### Get Weather Radar Tiles
```
GET /weather-radar/{z}/{x}/{y}.png
```

**Parameters:**
- `z` - Zoom level (0-9)
- `x` - Tile X coordinate
- `y` - Tile Y coordinate

**Query Parameters:**
- `size` - Tile size: `256` (default) or `512`
- `smooth` - Smoothing: `0` (default, no smoothing) or `1` (smoothed)
- `snow` - Snow overlay: `0` (default, no snow) or `1` (with snow)

**Examples:**
```bash
# Basic radar tile
https://utils.tak.nz/weather-radar/5/10/15.png

# High resolution with smoothing
https://utils.tak.nz/weather-radar/5/10/15.png?size=512&smooth=1

# With snow overlay
https://utils.tak.nz/weather-radar/5/10/15.png?snow=1

# All options combined
https://utils.tak.nz/weather-radar/5/10/15.png?size=512&smooth=1&snow=1
```

#### Health Check
```
GET /weather-radar/health
```

Returns service status and cache statistics.

### Rate Limiting
- **Limit**: 600 requests per minute per IP address
- **Response**: HTTP 429 when exceeded

### Error Responses

**400 Bad Request** - Invalid parameters
```json
{
  "error": "Invalid parameter",
  "message": "size parameter must be 256 or 512"
}
```

**401 Unauthorized** - Invalid API key
```json
{
  "error": "Unauthorized",
  "message": "Invalid API key"
}
```

**404 Not Found** - Tile not available
```json
{
  "error": "Tile not found",
  "message": "Weather data not available for this location"
}
```

**429 Too Many Requests** - Rate limit exceeded
```json
{
  "error": "Rate limit exceeded",
  "message": "Too many requests, please try again later"
}
```

**500 Service Error** - Service unavailable
```json
{
  "error": "Service unavailable",
  "message": "Weather service temporarily unavailable"
}
```

### Integration Notes

- **Caching**: Tiles are cached for 10 minutes
- **Attribution**: Weather data provided by RainViewer.com
- **CORS**: Cross-origin requests are supported
- **Retry Logic**: Service automatically retries failed requests
- **Fallback**: Returns transparent tiles on data unavailability
- **API Keys**: Supports RainViewer API keys for enhanced rate limits

### API Key Configuration

The weather-proxy service loads API keys from S3 for enhanced rate limits and reliability. API keys are stored in the base infrastructure config bucket.

**S3 Location**: `s3://{config-bucket}/ETL-Util-Weather-Proxy-Api-Keys.json`

**File Format**:
```json
{
  "rainviewer": {
    "primary": {
      "key": "your-primary-api-key-here",
      "comment": "Main production API key - high rate limit",
      "rateLimit": 10000,
      "enabled": true
    },
    "backup": {
      "key": "your-backup-api-key-here",
      "comment": "Backup key for failover scenarios",
      "rateLimit": 5000,
      "enabled": true
    },
    "development": {
      "key": "your-dev-api-key-here",
      "comment": "Development/testing key - lower limits",
      "rateLimit": 1000,
      "enabled": false
    }
  },
  "metadata": {
    "lastUpdated": "2024-01-15T10:30:00Z",
    "updatedBy": "admin@tak.nz",
    "notes": "Rotate keys quarterly"
  }
}
```

**Key Features**:
- **Primary/Backup Keys**: Automatic failover if primary key is disabled
- **Comments**: Documentation for each key's purpose and limits
- **Enable/Disable**: Control key usage without removing from file
- **Metadata**: Track updates and rotation schedules
- **Graceful Fallback**: Service continues in public mode if S3 config unavailable

**API Key Usage**:
When configured, users must provide a valid API key to access the weather-proxy service:
```
# Without API key (public access)
https://utils.tak.nz/weather-radar/5/10/15.png

# With API key (authenticated access)
https://utils.tak.nz/weather-radar/5/10/15.png?key=your-api-key
```
This allows you to control access and provide different rate limits for different users.

## Dual Image Strategy

Following the TAK-NZ pattern, this stack supports both local Docker builds and pre-built ECR images:

- **Development**: Uses local Docker builds from container folders
- **Production**: Uses pre-built images from ECR with tags

## Configuration

Environment-specific configuration is managed in `cdk.json`:

```json
{
  "dev-test": {
    "stackName": "Dev",
    "domain": "tak.nz",
    "utilsHostname": "utils",
    "containers": {
      "weather-proxy": {
        "enabled": true,
        "path": "/weather-radar",
        "port": 3000,
        "priority": 1
      }
    }
  }
}
```

## Deployment

### Prerequisites

1. Base infrastructure must be deployed (`base-infra` stack)
2. Node.js and AWS CDK installed
3. AWS credentials configured

### Commands

```bash
# Install dependencies
npm install

# Deploy to dev-test environment
npm run deploy

# Deploy to production
cdk deploy --context envType=prod

# Deploy with pre-built images
cdk deploy --context envType=prod --context usePreBuiltImages=true --context weather-proxyImageTag=v1.0.0
```

## Adding New Container Services

1. Create a new folder for your service (e.g., `my-service/`)
2. Add Dockerfile and application code
3. Update `cdk.json` to include the new container configuration
4. Deploy the stack

Example container configuration:
```json
"my-service": {
  "enabled": true,
  "path": "/my-service",
  "healthCheckPath": "/my-service/health",
  "port": 8080,
  "cpu": 256,
  "memory": 512,
  "priority": 2
}
```

## Infrastructure Dependencies

This stack imports resources from the base infrastructure:

- **VPC and Subnets** - Network infrastructure
- **ECS Cluster** - Container orchestration
- **SSL Certificate** - HTTPS termination
- **Route53 Hosted Zone** - DNS management
- **ECR Repository** - Container image storage (for pre-built images)
- **S3 Bucket** - ALB access logs and configuration storage

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

## Auto Scaling (Production)

Production environment includes auto scaling based on:
- **CPU Utilization** - Target 70%
- **Memory Utilization** - Target 80%
- **Scale Range** - 1-5 tasks per service