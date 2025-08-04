const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const NodeCache = require('node-cache');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY = process.env.CONFIG_KEY || 'ETL-Util-Camera-Proxy-Config.json';
const DEBUG = process.env.DEBUG === 'true';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

// Caches
const configCache = new NodeCache({ stdTTL: 3600 }); // 1 hour
const streamCache = new Map(); // Active streams
const rateLimitCache = new NodeCache({ stdTTL: 60 }); // 1 minute
const streamAccessTime = new Map(); // Track last access time

const IMAGES_DIR = '/data/images';
const STREAMS_DIR = '/data/streams';
const DOWNLOAD_INTERVAL = 30000; // 30 seconds to avoid rate limiting
const STREAM_TIMEOUT = 300000; // 5 minutes
const SEGMENT_DURATION = 10; // 10 seconds per segment
const PLAYLIST_SIZE = 6; // Keep 6 segments

// Ensure directories exist
fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(STREAMS_DIR, { recursive: true });

// Load configuration from S3
async function loadConfig() {
  const cached = configCache.get('config');
  if (cached) return cached;
  
  if (!CONFIG_BUCKET) {
    console.warn('CONFIG_BUCKET not set, using default config');
    const config = { allowedDomains: ['trafficnz.info', 'images.geonet.org.nz'], _publicMode: true };
    configCache.set('config', config);
    return config;
  }
  
  try {
    const command = new GetObjectCommand({
      Bucket: CONFIG_BUCKET,
      Key: CONFIG_KEY
    });
    
    const response = await s3Client.send(command);
    const body = await response.Body.transformToString();
    const config = JSON.parse(body);
    
    configCache.set('config', config);
    return config;
  } catch (error) {
    console.error('Failed to load config from S3:', error.message);
    const config = { allowedDomains: ['trafficnz.info', 'images.geonet.org.nz'], _publicMode: true };
    configCache.set('config', config);
    return config;
  }
}

// Validate URL domain
async function validateUrl(url) {
  try {
    const urlObj = new URL(url);
    const config = await loadConfig();
    
    return config.allowedDomains.some(domain => 
      urlObj.hostname === domain || urlObj.hostname.endsWith('.' + domain)
    );
  } catch (error) {
    return false;
  }
}

// Download image from URL
async function downloadImage(url, filepath) {
  try {
    console.log(`Attempting to download: ${url}`);
    const response = await fetch(url, {
      timeout: 30000, // Increased to 30 seconds
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/jpeg,image/png,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache'
      }
    });
    
    console.log(`Response status: ${response.status}`);
    if (!response.ok) {
      if (response.status === 429) {
        console.warn(`Rate limited for ${url}`);
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    console.log(`Downloaded ${buffer.byteLength} bytes`);
    
    if (buffer.byteLength === 0) {
      throw new Error('Downloaded file is empty');
    }
    
    fs.writeFileSync(filepath, Buffer.from(buffer));
    console.log(`Saved to: ${filepath}`);
    return true;
  } catch (error) {
    console.error(`Download failed for ${url}:`, error.message);
    return false;
  }
}

// MJPEG stream manager
class MJPEGStream {
  constructor(streamId) {
    this.streamId = streamId;
    this.clients = new Set();
    this.currentImage = null;
    this.frameInterval = null;
  }
  
  addClient(res) {
    this.clients.add(res);
    console.log(`Client connected to MJPEG stream ${this.streamId}, total: ${this.clients.size}`);
    
    res.on('close', () => {
      this.clients.delete(res);
      console.log(`Client disconnected from MJPEG stream ${this.streamId}, total: ${this.clients.size}`);
      
      // Stop continuous frames if no clients
      if (this.clients.size === 0) {
        this.stopContinuousFrames();
      }
    });
    
    // Send current image immediately if available
    if (this.currentImage) {
      this.sendImageToClient(res, this.currentImage);
    }
    
    // Start continuous frames for ATAK compatibility
    this.startContinuousFrames();
  }
  
  startContinuousFrames() {
    if (this.frameInterval) return; // Already running
    
    this.frameInterval = setInterval(() => {
      if (this.currentImage && this.clients.size > 0) {
        this.broadcastImage(this.currentImage);
      }
    }, 3000); // Send frame every 3 seconds
  }
  
  stopContinuousFrames() {
    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = null;
    }
  }
  
  updateImage(imageBuffer) {
    this.currentImage = imageBuffer;
    // Don't broadcast immediately - let continuous frames handle it
  }
  
  broadcastImage(imageBuffer) {
    const deadClients = [];
    
    for (const client of this.clients) {
      try {
        this.sendImageToClient(client, imageBuffer);
      } catch (error) {
        deadClients.push(client);
      }
    }
    
    // Remove dead clients
    deadClients.forEach(client => this.clients.delete(client));
  }
  
  sendImageToClient(res, imageBuffer) {
    res.write(`--frame\r\n`);
    res.write(`Content-Type: image/jpeg\r\n`);
    res.write(`Content-Length: ${imageBuffer.length}\r\n\r\n`);
    res.write(imageBuffer);
    res.write('\r\n');
  }
  
  hasClients() {
    return this.clients.size > 0;
  }
}

// HLS generation removed

// Stream management
class StreamManager {
  constructor(streamId, imageUrl) {
    this.streamId = streamId;
    this.imageUrl = imageUrl;
    this.imageFile = path.join(IMAGES_DIR, `${streamId}.jpg`);
    this.outputDir = path.join(STREAMS_DIR, streamId);
    this.downloadInterval = null;
    this.lastUpdate = new Date();
    this.mjpegStream = new MJPEGStream(streamId);
    this.ffmpegProcess = null;
    
    fs.mkdirSync(this.outputDir, { recursive: true });
  }
  
  async start() {
    if (this.isActive()) return; // Already running
    
    // Try initial download, but continue even if it fails
    const success = await this.downloadImage();
    if (!success) {
      console.warn(`Initial download failed for stream ${this.streamId}, will retry`);
    } else {
      console.log(`Successfully downloaded initial image for stream ${this.streamId}`);
    }
    
    // HLS support removed
    
    // Start periodic downloads
    this.downloadInterval = setInterval(() => {
      this.downloadImage();
    }, DOWNLOAD_INTERVAL);
    
    console.log(`Started MJPEG stream ${this.streamId} for ${this.imageUrl}`);
  }
  
  async downloadImage() {
    const success = await downloadImage(this.imageUrl, this.imageFile);
    if (success) {
      this.lastUpdate = new Date();
      
      // Update MJPEG stream with new image
      try {
        const imageBuffer = fs.readFileSync(this.imageFile);
        this.mjpegStream.updateImage(imageBuffer);
      } catch (error) {
        console.error(`Failed to read image file for stream ${this.streamId}:`, error.message);
      }
    }
    return success;
  }
  
  // HLS methods removed
  
  stop() {
    if (this.downloadInterval) {
      clearInterval(this.downloadInterval);
      this.downloadInterval = null;
    }
    
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill();
      this.ffmpegProcess = null;
    }
    
    console.log(`Stopped MJPEG stream ${this.streamId}`);
  }
  
  isActive() {
    return this.downloadInterval !== null;
  }
  
  getMJPEGStream() {
    return this.mjpegStream;
  }
  
  getPlaylistPath() {
    return path.join(this.outputDir, 'playlist.m3u8');
  }
}

// Generate stream ID from URL
function generateStreamId(url) {
  return Buffer.from(url).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
}

// Get or create stream on demand
async function getOrCreateStream(url) {
  const isValidUrl = await validateUrl(url);
  if (!isValidUrl) {
    throw new Error('Domain not allowed');
  }
  
  const streamId = generateStreamId(url);
  
  if (!streamCache.has(streamId)) {
    const stream = new StreamManager(streamId, url);
    streamCache.set(streamId, stream);
    await stream.start();
  }
  
  // Update access time
  streamAccessTime.set(streamId, new Date());
  
  return streamCache.get(streamId);
}

// Rate limiting
function checkRateLimit(ip) {
  const key = `rate_${ip}`;
  const current = rateLimitCache.get(key) || 0;
  
  if (current >= 60) { // 60 requests per minute
    return false;
  }
  
  rateLimitCache.set(key, current + 1);
  return true;
}

// Routes
app.get('/camera-proxy/health', (req, res) => {
  res.json({
    status: 'ok',
    activeStreams: streamCache.size,
    configBucket: !!CONFIG_BUCKET,
    uptime: process.uptime()
  });
});

app.use(express.json());

app.get('/camera-proxy/stream/mjpeg', async (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }
  
  try {
    const stream = await getOrCreateStream(url);
    
    // Set MJPEG headers
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Access-Control-Allow-Origin': '*'
    });
    
    // Add client to MJPEG stream
    stream.getMJPEGStream().addClient(res);
    
    console.log(`MJPEG client connected to stream ${stream.streamId}`);
    
  } catch (error) {
    res.status(403).json({ error: error.message });
  }
});

// HLS support removed

// HLS segment endpoint removed

app.get('/camera-proxy/streams', (req, res) => {
  const streams = Array.from(streamCache.entries()).map(([id, stream]) => ({
    streamId: id,
    url: stream.imageUrl,
    active: stream.isActive(),
    lastUpdate: stream.lastUpdate,
    lastAccess: streamAccessTime.get(id),
    mjpegUrl: `/camera-proxy/stream/mjpeg?url=${encodeURIComponent(stream.imageUrl)}`
  }));
  
  res.json({ streams });
});

// Cleanup inactive streams
setInterval(() => {
  const cutoffTime = new Date(Date.now() - STREAM_TIMEOUT);
  
  for (const [streamId, lastAccess] of streamAccessTime.entries()) {
    if (lastAccess < cutoffTime) {
      const stream = streamCache.get(streamId);
      if (stream && !stream.getMJPEGStream().hasClients()) {
        console.log(`Cleaning up inactive stream ${streamId}`);
        stream.stop();
        streamCache.delete(streamId);
        streamAccessTime.delete(streamId);
      }
    }
  }
}, 60000); // Check every minute

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  for (const stream of streamCache.values()) {
    stream.stop();
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Camera proxy server running on port ${PORT}`);
  console.log(`Images directory: ${IMAGES_DIR}`);
  console.log('MJPEG streams will start automatically when accessed');
});