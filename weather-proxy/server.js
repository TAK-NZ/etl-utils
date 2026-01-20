const express = require('express');
const sharp = require('sharp');
const NodeCache = require('node-cache');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10 minutes cache
const timestampCache = new NodeCache({ stdTTL: 300 }); // 5 minutes for timestamps
const rateLimitCache = new NodeCache({ stdTTL: 60 }); // 1 minute for rate limiting
const apiKeyCache = new NodeCache({ stdTTL: 3600 }); // 1 hour for API keys

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

const PORT = process.env.PORT || 3000;
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY = process.env.CONFIG_KEY || 'ETL-Util-Weather-Proxy-Api-Keys.json';
const TILES_BUCKET = process.env.TILES_BUCKET || CONFIG_BUCKET;
const MAX_ZOOM_LEVEL = 9;
const RATE_LIMIT_PER_MINUTE = 600; // RainViewer allows 600 requests per minute
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Coverage boundaries (approximate global coverage)
const COVERAGE_BOUNDS = {
  minLat: -85,
  maxLat: 85,
  minLng: -180,
  maxLng: 180
};

// Rate limiting middleware
function rateLimit(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress;
  const key = `rate_${clientIp}`;
  const current = rateLimitCache.get(key) || 0;
  
  if (current >= RATE_LIMIT_PER_MINUTE) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Too many requests, please try again later'
    });
  }
  
  rateLimitCache.set(key, current + 1);
  next();
}

// API key-specific rate limiting
function checkApiKeyRateLimit(apiKey, rateLimit) {
  if (!rateLimit) return { allowed: true };
  
  const key = `api_rate_${apiKey}`;
  const current = rateLimitCache.get(key) || 0;
  
  if (current >= rateLimit) {
    return { 
      allowed: false, 
      message: `API key rate limit exceeded (${rateLimit}/min)` 
    };
  }
  
  rateLimitCache.set(key, current + 1);
  return { allowed: true };
}

// Validate tile coordinates
function validateTileCoordinates(z, x, y) {
  const zoom = parseInt(z);
  const tileX = parseInt(x);
  const tileY = parseInt(y);
  
  if (isNaN(zoom) || isNaN(tileX) || isNaN(tileY)) {
    return { valid: false, error: 'Invalid tile coordinates: must be numbers' };
  }
  
  if (zoom < 0 || zoom > MAX_ZOOM_LEVEL) {
    return { valid: false, error: `Invalid zoom level: must be 0-${MAX_ZOOM_LEVEL}` };
  }
  
  const maxTile = Math.pow(2, zoom) - 1;
  if (tileX < 0 || tileX > maxTile || tileY < 0 || tileY > maxTile) {
    return { valid: false, error: `Invalid tile coordinates for zoom ${zoom}` };
  }
  
  return { valid: true, zoom, tileX, tileY };
}

// Load API keys from S3
async function loadApiKeys() {
  const cached = apiKeyCache.get('keys');
  if (cached) return cached;
  
  if (!CONFIG_BUCKET) {
    console.warn('CONFIG_BUCKET not set, using public mode');
    const config = { rainviewer: {}, _publicMode: true };
    apiKeyCache.set('keys', config);
    return config;
  }
  
  try {
    const command = new GetObjectCommand({
      Bucket: CONFIG_BUCKET,
      Key: CONFIG_KEY
    });
    
    const response = await s3Client.send(command);
    const body = await response.Body.transformToString();
    const keys = JSON.parse(body);
    
    apiKeyCache.set('keys', keys);
    return keys;
  } catch (error) {
    console.error('Failed to load API keys from S3:', error.message);
    const config = { rainviewer: {}, _publicMode: true };
    apiKeyCache.set('keys', config);
    return config;
  }
}

// Validate API key from request
async function validateApiKey(providedKey) {
  if (!providedKey) return { valid: false, reason: 'No API key provided' };
  
  const keys = await loadApiKeys();
  
  // If in public mode (no config file), accept any API key
  if (keys._publicMode) {
    return { valid: true, keyName: 'public', rateLimit: null };
  }
  
  const rainviewerKeys = keys.rainviewer || {};
  
  for (const [keyName, keyConfig] of Object.entries(rainviewerKeys)) {
    if (keyConfig.enabled && keyConfig.key === providedKey) {
      return { valid: true, keyName, rateLimit: keyConfig.rateLimit };
    }
  }
  
  return { valid: false, reason: 'Invalid API key' };
}

// Retry with exponential backoff
async function retryWithBackoff(fn, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      const delay = RETRY_DELAY_MS * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

app.use(express.json());
app.set('trust proxy', true);



// Get latest radar timestamp from RainViewer
async function getLatestTimestamp() {
    const cached = timestampCache.get('latest');
    if (cached) return cached;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    try {
        const response = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
            signal: controller.signal,
            headers: { 'User-Agent': 'weather-proxy/1.0' }
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`RainViewer API error: ${response.status}`);
        }
        
        const data = await response.json();
        const latest = data.radar.past[data.radar.past.length - 1];
        
        timestampCache.set('latest', latest.time);
        return latest.time;
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('Failed to get timestamp, using fallback:', error.message);
        // Use current time minus 10 minutes as fallback
        const fallbackTime = Math.floor((Date.now() - 600000) / 1000);
        timestampCache.set('latest', fallbackTime);
        return fallbackTime;
    }
}

// Fetch radar tile from RainViewer with retry logic
async function fetchRadarTile(z, x, y, smooth = 0, size = 256, snow = 0) {
    return await retryWithBackoff(async () => {
        const timestamp = await getLatestTimestamp();
        const url = `https://tilecache.rainviewer.com/v2/radar/${timestamp}/${size}/${z}/${x}/${y}/1/${smooth}_${snow}.png`;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        
        try {
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'weather-proxy/1.0',
                    'Attribution': 'Weather data provided by RainViewer.com'
                }
            });
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error('Tile not found');
                } else if (response.status === 429) {
                    throw new Error('Rate limit exceeded');
                } else if (response.status >= 500) {
                    throw new Error(`Server error: ${response.status}`);
                } else {
                    throw new Error(`API error: ${response.status}`);
                }
            }
            
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    });
}

// Generate radar tile with enhanced parameters
async function generateRadarTile(z, x, y, smooth = 0, size = 256, snow = 0) {
    const cacheKey = `radar-${z}-${x}-${y}-${smooth}-${size}-${snow}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const buffer = await fetchRadarTile(z, x, y, smooth, size, snow);
        cache.set(cacheKey, buffer);
        return buffer;
        
    } catch (error) {
        console.error(`Error generating radar tile ${z}/${x}/${y}:`, error.message);
        // Return empty transparent tile on error
        const buffer = await sharp({
            create: {
                width: size,
                height: size,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            }
        }).png().toBuffer();
        return buffer;
    }
}

// Get MetService tile from S3
async function getMetServiceTile(z, x, y) {
    const cacheKey = `metservice-${z}-${x}-${y}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const s3Key = `metservice-radar/${z}/${x}/${y}.png`;
    
    try {
        const command = new GetObjectCommand({
            Bucket: TILES_BUCKET,
            Key: s3Key
        });
        
        const response = await s3Client.send(command);
        const buffer = Buffer.from(await response.Body.transformToByteArray());
        
        cache.set(cacheKey, buffer);
        return buffer;
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            return await sharp({
                create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
            }).png().toBuffer();
        }
        throw error;
    }
}

// Routes with /weather-radar prefix
app.get('/weather-radar/health', async (req, res) => {
    try {
        const keys = await loadApiKeys();
        const enabledKeys = Object.values(keys.rainviewer || {}).filter(k => k.enabled).length;
        
        res.json({ 
            status: 'ok', 
            cache_keys: cache.keys().length,
            timestamp_cache: timestampCache.keys().length,
            api_keys_configured: enabledKeys,
            public_mode: !!keys._publicMode,
            config_bucket: !!CONFIG_BUCKET,
            tiles_bucket: !!TILES_BUCKET
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Health check failed'
        });
    }
});



app.get('/weather-radar/:z/:x/:y.png', rateLimit, async (req, res) => {
    const { z, x, y } = req.params;
    const smooth = parseInt(req.query.smooth) || 0;
    const size = parseInt(req.query.size) || 256;
    const snow = parseInt(req.query.snow) || 0;
    const apiKey = req.query.key;
    
    // Validate API key if provided
    let keyValidation = null;
    if (apiKey) {
        keyValidation = await validateApiKey(apiKey);
        if (!keyValidation.valid) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: keyValidation.reason
            });
        }
        
        // Check API key-specific rate limit
        const rateLimitCheck = checkApiKeyRateLimit(apiKey, keyValidation.rateLimit);
        if (!rateLimitCheck.allowed) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                message: rateLimitCheck.message
            });
        }
    }
    
    // Validate tile coordinates
    const validation = validateTileCoordinates(z, x, y);
    if (!validation.valid) {
        return res.status(400).json({
            error: 'Invalid request',
            message: validation.error
        });
    }
    
    const { zoom, tileX, tileY } = validation;
    
    // Validate parameters
    if (smooth < 0 || smooth > 1) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'smooth parameter must be 0 or 1'
        });
    }
    
    if (![256, 512].includes(size)) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'size parameter must be 256 or 512'
        });
    }
    
    if (snow < 0 || snow > 1) {
        return res.status(400).json({
            error: 'Invalid parameter',
            message: 'snow parameter must be 0 or 1'
        });
    }
    
    try {
        const tileBuffer = await generateRadarTile(zoom, tileX, tileY, smooth, size, snow);
        
        res.set({
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=600',
            'Access-Control-Allow-Origin': '*',
            'Attribution': 'Weather data provided by RainViewer.com'
        });
        
        res.send(tileBuffer);
    } catch (error) {
        console.error('Radar tile generation error:', error.message);
        
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                message: 'Too many requests to weather service'
            });
        } else if (error.message.includes('not found')) {
            return res.status(404).json({
                error: 'Tile not found',
                message: 'Weather data not available for this location'
            });
        } else {
            return res.status(500).json({
                error: 'Service unavailable',
                message: 'Weather service temporarily unavailable'
            });
        }
    }
});

// MetService tiles
app.get('/weather-radar/metservice/:z/:x/:y.png', rateLimit, async (req, res) => {
    const { z, x, y } = req.params;
    const apiKey = req.query.key;
    
    if (apiKey) {
        const keyValidation = await validateApiKey(apiKey);
        if (!keyValidation.valid) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: keyValidation.reason
            });
        }
        
        const rateLimitCheck = checkApiKeyRateLimit(apiKey, keyValidation.rateLimit);
        if (!rateLimitCheck.allowed) {
            return res.status(429).json({
                error: 'Rate limit exceeded',
                message: rateLimitCheck.message
            });
        }
    }
    
    const validation = validateTileCoordinates(z, x, y);
    if (!validation.valid) {
        return res.status(400).json({
            error: 'Invalid request',
            message: validation.error
        });
    }
    
    const { zoom, tileX, tileY } = validation;
    
    try {
        const tileBuffer = await getMetServiceTile(zoom, tileX, tileY);
        
        res.set({
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=300',
            'Access-Control-Allow-Origin': '*',
            'Attribution': 'Weather data provided by MetService'
        });
        
        res.send(tileBuffer);
    } catch (error) {
        console.error('MetService tile error:', error.message);
        return res.status(404).json({
            error: 'Tile not found',
            message: 'MetService data not available for this location'
        });
    }
});

app.listen(PORT, () => {
    console.log(`RainViewer radar proxy server running on port ${PORT}`);
    console.log(`Max zoom: ${MAX_ZOOM_LEVEL}, Rate limit: ${RATE_LIMIT_PER_MINUTE}/min`);
    console.log(`Supports: ?size=256|512, ?smooth=0|1, ?snow=0|1`);
});