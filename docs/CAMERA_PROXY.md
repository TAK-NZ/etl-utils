# Camera Proxy API

The Camera Proxy service converts static camera images into HLS video streams by downloading images at regular intervals and generating live video segments.

## Overview

- **Base URL**: `https://utils.{domain}/camera-proxy`
- **On-demand streaming**: Streams start automatically when accessed
- **Image download interval**: 10 seconds
- **HLS segment duration**: 10 seconds
- **Playlist size**: 6 segments (1 minute of video)
- **Stream timeout**: 5 minutes of inactivity

## API Endpoints

### Get HLS Playlist
```
GET /camera-proxy/stream/playlist.m3u8?url={image_url}
```

**Parameters:**
- `url` (required): URL of the static image to stream

**Response:**
- Content-Type: `application/vnd.apple.mpegurl`
- Returns HLS playlist file

**Example:**
```
GET /camera-proxy/stream/playlist.m3u8?url=https://www.trafficnz.info/camera/628.jpg
```

### Get Video Segment
```
GET /camera-proxy/stream/{segment.ts}?url={image_url}
```

**Parameters:**
- `segment.ts`: HLS segment filename (e.g., `segment0.ts`)
- `url` (required): URL of the static image

**Response:**
- Content-Type: `video/mp2t`
- Returns video segment data

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
      "playlistUrl": "/camera-proxy/stream/playlist.m3u8?url=..."
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

### Direct HLS Streaming
```bash
# Play with ffplay
ffplay "https://utils.tak.nz/camera-proxy/stream/playlist.m3u8?url=https://www.trafficnz.info/camera/628.jpg"

# Play with VLC
vlc "https://utils.tak.nz/camera-proxy/stream/playlist.m3u8?url=https://www.trafficnz.info/camera/628.jpg"
```

### Web Player
```html
<video controls>
  <source src="/camera-proxy/stream/playlist.m3u8?url=https://www.trafficnz.info/camera/628.jpg" 
          type="application/vnd.apple.mpegurl">
</video>
```

### JavaScript HLS Player
```javascript
// Using hls.js
const video = document.getElementById('video');
const hls = new Hls();
hls.loadSource('/camera-proxy/stream/playlist.m3u8?url=https://www.trafficnz.info/camera/628.jpg');
hls.attachMedia(video);
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

- **Automatic start**: Streams begin when playlist is first requested
- **Access tracking**: Last access time tracked for cleanup
- **Automatic cleanup**: Inactive streams stopped after 5 minutes
- **Resource efficient**: Only active streams consume resources

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
  "error": "Playlist not ready"
}
```

### 429 Too Many Requests
```json
{
  "error": "Rate limit exceeded"
}
```

## Technical Details

- **Image format**: Any format supported by FFmpeg
- **Video codec**: H.264 (libx264)
- **Container**: MPEG-TS segments
- **Preset**: ultrafast (optimized for real-time)
- **Pixel format**: yuv420p (wide compatibility)
- **Frame rate**: 0.1 fps (10 seconds per image)

## Monitoring

- **Health checks**: Simple status endpoint for load balancer
- **CloudWatch logs**: Application and error logs
- **Stream metrics**: Active stream count and access patterns
- **Resource usage**: CPU and memory monitoring via ECS