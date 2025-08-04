# Camera Proxy API

The Camera Proxy service converts static camera images into MJPEG video streams by downloading images at regular intervals and broadcasting them to connected clients.

## Overview

- **Base URL**: `https://utils.{domain}/camera-proxy`
- **On-demand streaming**: Streams start automatically when accessed
- **Image download interval**: 30 seconds
- **Frame broadcast interval**: 3 seconds (for ATAK compatibility)
- **Stream timeout**: 5 minutes of inactivity

## API Endpoints

### Get MJPEG Stream
```
GET /camera-proxy/stream/mjpeg?url={image_url}
```

**Parameters:**
- `url` (required): URL of the static image to stream

**Response:**
- Content-Type: `multipart/x-mixed-replace; boundary=frame`
- Returns continuous MJPEG stream

**Example:**
```
GET /camera-proxy/stream/mjpeg?url=https://www.trafficnz.info/camera/628.jpg
```

### List Active Streams
```
GET /camera-proxy/streams
```

**Response:**
```json
{
  "streams": [
    {
      "streamId": "abc123",
      "url": "https://www.trafficnz.info/camera/628.jpg",
      "active": true,
      "lastUpdate": "2024-01-01T12:00:00.000Z",
      "lastAccess": "2024-01-01T12:05:00.000Z",
      "mjpegUrl": "/camera-proxy/stream/mjpeg?url=..."
    }
  ]
}
```

### Health Check
```
GET /camera-proxy/health
```

**Response:**
```json
{
  "status": "ok",
  "activeStreams": 2,
  "configBucket": true,
  "uptime": 3600
}
```

## Usage Examples

### Direct MJPEG Streaming
```bash
# Play with ffplay
ffplay "https://utils.tak.nz/camera-proxy/stream/mjpeg?url=https://www.trafficnz.info/camera/628.jpg"

# Play with VLC
vlc "https://utils.tak.nz/camera-proxy/stream/mjpeg?url=https://www.trafficnz.info/camera/628.jpg"
```

### ATAK Integration
```xml
<!-- Add to ATAK video feeds -->
<video>
  <source>https://utils.tak.nz/camera-proxy/stream/mjpeg?url=https://www.trafficnz.info/camera/628.jpg</source>
  <type>mjpeg</type>
</video>
```

### Web Browser
```html
<!-- Direct MJPEG display -->
<img src="/camera-proxy/stream/mjpeg?url=https://www.trafficnz.info/camera/628.jpg" 
     alt="Live Camera Feed">
```

## Configuration

The service uses S3 configuration to manage allowed domains:

**S3 Config File**: `ETL-Util-Camera-Proxy-Config.json`

```json
{
  "allowedDomains": [
    "trafficnz.info",
    "www.trafficnz.info",
    "example.com"
  ]
}
```

## Environment Variables

- `CONFIG_BUCKET` - S3 bucket containing configuration
- `CONFIG_KEY` - S3 key for config file (default: `ETL-Util-Camera-Proxy-Config.json`)
- `PORT` - Server port (default: 3000)
- `DEBUG` - Enable debug logging (default: false)

## Stream Management

- **Automatic start**: Streams begin when MJPEG endpoint is first accessed
- **Client tracking**: Active client connections monitored
- **Automatic cleanup**: Inactive streams stopped after 5 minutes
- **Resource efficient**: Only streams with active clients consume resources
- **Continuous frames**: Sends frames every 3 seconds for ATAK compatibility

## Rate Limiting

- **60 requests per minute** per IP address
- Applied to all endpoints

## Error Responses

### 400 Bad Request
```json
{
  "error": "URL parameter required"
}
```

### 403 Forbidden
```json
{
  "error": "Domain not allowed"
}
```

### 404 Not Found
```json
{
  "error": "Stream not found"
}
```

### 429 Too Many Requests
```json
{
  "error": "Rate limit exceeded"
}
```

## Technical Details

- **Stream format**: MJPEG (Motion JPEG)
- **Image format**: JPEG images from static URLs
- **Container**: multipart/x-mixed-replace HTTP stream
- **Frame delivery**: Continuous broadcast every 3 seconds
- **Download interval**: 30 seconds (to avoid rate limiting)
- **Boundary**: `--frame` with proper MIME headers

## Monitoring

- **Health checks**: Simple status endpoint for load balancer
- **CloudWatch logs**: Application and error logs
- **Stream metrics**: Active stream count and access patterns
- **Resource usage**: CPU and memory monitoring via ECS