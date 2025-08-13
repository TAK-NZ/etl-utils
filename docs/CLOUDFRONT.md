# CloudFront CDN for TileServer GL

## Overview

CloudFront CDN is optionally deployed in front of the TileServer GL service to provide:
- Global content delivery for improved performance
- Intelligent caching for tiles and metadata
- SSL termination with us-east-1 certificate
- Reduced load on origin ALB

## Configuration

CloudFront is controlled via `cdk.json` configuration:

```json
{
  "cloudfront": {
    "tileserver": {
      "enabled": true,
      "cacheTtl": {
        "tiles": "30d",
        "metadata": "1h", 
        "health": "0s"
      }
    }
  }
}
```

### Cache TTL Format
- `30d` = 30 days
- `1h` = 1 hour  
- `5m` = 5 minutes
- `0s` = 0 seconds (no cache)

## Architecture

When enabled, CloudFront sits between users and the ALB:

```
User → CloudFront → ALB → ECS TileServer GL
```

### DNS Routing

- **CloudFront enabled**: `tiles.{domain}` → CloudFront distribution → ALB
- **CloudFront disabled**: `tiles.{domain}` → ALB directly
- Route53 records are automatically updated based on configuration

### Cache Behaviors

| Path Pattern | Cache Policy | TTL | Purpose |
|--------------|--------------|-----|---------|
| `/styles/*` | Long cache | 30 days | All tile content (png, webp, pbf, etc.) |
| `/health` | No cache | 0 seconds | Health checks |
| Default | Metadata cache | 1 hour | Root paths, fonts, other resources |

### SSL Certificate

- **Cross-region certificate**: Automatically created in us-east-1 for CloudFront compatibility
- **DNS validation**: Uses existing Route53 hosted zone for fast validation
- **Self-contained**: No dependency on base infrastructure
- **Domain coverage**: `tiles.{domain}` hostname

## Deployment

### Prerequisites
- Container `tileserver-gl` must have `hostname` configured
- Base infrastructure must be deployed

### Enable CloudFront
```bash
# Deploy with CloudFront enabled (default)
npm run deploy

# Deploy to production
cdk deploy --context envType=prod
```

### Disable CloudFront
Set `cloudfront.tileserver.enabled: false` in `cdk.json` and redeploy.

### Deployment Notes
- **Certificate creation**: Takes 2-5 minutes for DNS validation
- **Route53 updates**: Automatic, no manual intervention needed
- **Zero conflicts**: Safe to enable/disable without DNS issues

## Route53 Management

**Automatic DNS Updates**:
- Stack automatically creates/updates A and AAAA records
- **CloudFront enabled**: Records point to CloudFront distribution
- **CloudFront disabled**: Records point directly to ALB
- **No conflicts**: Existing records are replaced, not duplicated
- **Zero downtime**: DNS changes propagate within minutes

## Monitoring

CloudFront metrics available in CloudWatch:
- Cache hit ratio
- Origin latency
- Error rates
- Data transfer

## Cache Invalidation

To invalidate cached content:

```bash
aws cloudfront create-invalidation \
  --distribution-id DISTRIBUTION_ID \
  --paths "/styles/*"
```

## Performance Benefits

Expected improvements with CloudFront:
- **Global performance**: 50-80% reduction in tile load times
- **Origin offload**: 60-90% reduction in ALB requests
- **User experience**: Faster map loading and interactions
- **Cost savings**: Reduced ECS/ALB resource usage
- **Scalability**: Handles traffic spikes automatically

## Costs

**CloudFront pricing**:
- Data transfer out (~$0.085/GB)
- HTTP/HTTPS requests (~$0.0075/10k requests)
- Geographic distribution (varies by region)

**Cost optimization**:
- Reduced ECS/ALB usage offsets CloudFront costs
- Long cache TTLs minimize origin requests
- Automatic scaling reduces over-provisioning

**Typical savings**: 20-40% reduction in total infrastructure costs for tile serving workloads.