# AIS Proxy Service

The ais-proxy service provides AISHub-compatible access to real-time AIS vessel data from AISStream.

## Base URL
```
https://utils.{domain}/ais-proxy/
```

## Endpoints

### Get Vessel Data
```
GET /ais-proxy/ws.php?username={api_key}&latmin={lat}&latmax={lat}&lonmin={lon}&lonmax={lon}
```

**Parameters:**
- `username` - Your API key for authentication
- `latmin` - Minimum latitude (decimal degrees)
- `latmax` - Maximum latitude (decimal degrees)
- `lonmin` - Minimum longitude (decimal degrees)
- `lonmax` - Maximum longitude (decimal degrees)

**Example:**
```bash
# Get vessels in New Zealand waters
https://utils.tak.nz/ais-proxy/ws.php?username=your-api-key&latmin=-48&latmax=-34&lonmin=166&lonmax=179
```

**Response:**
```json
{
  "VESSELS": [
    {
      "MMSI": 123456789,
      "TIME": "2024-01-15 10:30:00 UTC",
      "LONGITUDE": 174.7633,
      "LATITUDE": -36.8485,
      "COG": 45.2,
      "SOG": 12.5,
      "HEADING": 47,
      "NAVSTAT": 0,
      "IMO": 9876543,
      "NAME": "VESSEL NAME",
      "CALLSIGN": "ABC123",
      "TYPE": 70,
      "A": 100,
      "B": 20,
      "C": 15,
      "D": 5,
      "DRAUGHT": 8.5,
      "DEST": "AUCKLAND",
      "ETA": "01/15 14:30"
    }
  ]
}
```

### Health Check
```
GET /ais-proxy/health
```

Returns service status and configuration information.

## Rate Limiting
- **IP-based**: 600 requests per minute per IP address (default)
- **API Key-based**: Custom limits per API key (when configured)
- **Response**: HTTP 429 when exceeded

## Error Responses

**Invalid API Key or Missing Parameters:**
```json
{
  "ERROR": true
}
```

**Rate Limit Exceeded:**
```json
{
  "ERROR": true,
  "MESSAGE": "API key rate limit exceeded (1000/min)"
}
```

## API Key Configuration

The ais-proxy service loads API keys from S3 for user authentication and AISStream connectivity.

**S3 Location**: `s3://{config-bucket}/ETL-Util-AIS-Proxy-Api-Keys.json`

**File Format:**
```json
{
  "aisstream": {
    "primary": {
      "key": "your-aisstream-api-key-here",
      "comment": "Primary AISStream API key",
      "enabled": true
    },
    "backup": {
      "key": "your-backup-aisstream-key-here",
      "comment": "Backup AISStream API key",
      "enabled": false
    }
  },
  "users": {
    "primary": {
      "key": "user-api-key-1",
      "comment": "Primary user API key - high rate limit",
      "rateLimit": 10000,
      "enabled": true
    },
    "secondary": {
      "key": "user-api-key-2",
      "comment": "Secondary user API key - lower limits",
      "rateLimit": 1000,
      "enabled": true
    },
    "development": {
      "key": "dev-api-key",
      "comment": "Development/testing key",
      "rateLimit": 500,
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

**Key Features:**
- **AISStream Keys**: Primary/backup keys for connecting to AISStream service
- **User Keys**: Individual API keys for service users with custom rate limits
- **Per-Key Rate Limits**: Individual rate limits for each user API key
- **Enable/Disable**: Control key usage without removing from file
- **Graceful Fallback**: Service continues in public mode if S3 config unavailable

## Integration Notes

- **Data Source**: Real-time AIS data from AISStream WebSocket
- **Coverage**: New Zealand waters (configurable bounding box)
- **Caching**: Vessel data cached in memory with 1-hour expiration
- **Persistence**: Cache persisted to disk for service restarts
- **Compatibility**: AISHub-compatible API format (vessels only, no navigation aids)
- **WebSocket**: Maintains persistent connection to AISStream
- **Reconnection**: Automatic reconnection on connection loss
- **Filtering**: Navigation aids are automatically filtered out to maintain AISHub compatibility

## Data Fields

Each vessel record includes:
- **MMSI**: Maritime Mobile Service Identity
- **TIME**: Last update timestamp (UTC)
- **LONGITUDE/LATITUDE**: Current position
- **COG**: Course over ground (degrees)
- **SOG**: Speed over ground (knots)
- **HEADING**: True heading (degrees)
- **NAVSTAT**: Navigational status code
- **IMO**: International Maritime Organization number
- **NAME**: Vessel name
- **CALLSIGN**: Radio call sign
- **TYPE**: Vessel type code
- **A/B/C/D**: Vessel dimensions (meters)
- **DRAUGHT**: Maximum draught (meters)
- **DEST**: Destination
- **ETA**: Estimated time of arrival