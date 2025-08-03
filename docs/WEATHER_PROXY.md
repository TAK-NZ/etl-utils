# Weather Proxy Service

The weather-proxy service provides access to real-time weather radar data from RainViewer.

## Base URL
```
https://utils.{domain}/weather-radar/
```

## Endpoints

### Get Weather Radar Tiles
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

### Health Check
```
GET /weather-radar/health
```

Returns service status and cache statistics.

## Rate Limiting
- **IP-based**: 600 requests per minute per IP address (default)
- **API Key-based**: Custom limits per API key (when configured)
- **Response**: HTTP 429 when exceeded
- **Precedence**: API key limits take precedence over IP limits

## Error Responses

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

## Integration Notes

- **Caching**: Tiles are cached for 10 minutes
- **Attribution**: Weather data provided by RainViewer.com
- **CORS**: Cross-origin requests are supported
- **Retry Logic**: Service automatically retries failed requests
- **Fallback**: Returns transparent tiles on data unavailability
- **API Keys**: Supports RainViewer API keys for enhanced rate limits

## API Key Configuration

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
- **Per-Key Rate Limits**: Individual rate limits for each API key
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