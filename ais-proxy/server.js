import express from 'express';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const app = express();
app.use(express.json({ limit: '10mb' }));
const PORT = process.env.PORT || 3000;
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY = process.env.CONFIG_KEY || 'ETL-Util-AIS-Proxy-Api-Keys.json';
const DEBUG = process.env.DEBUG === 'true';
const CACHE_FILE = '/data/vessel-cache.json';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

// In-memory caches with size limits
const vesselCache = new Map();
const apiKeyCache = new Map();
const rateLimitCache = new Map();
const clientStatusCache = new Map(); // Track AIS upload clients
const MAX_VESSEL_CACHE_SIZE = 50000;
const MAX_RATE_LIMIT_CACHE_SIZE = 10000;
const nameLookupQueue = [];
let nameLookupInProgress = false;



const RATE_LIMIT_PER_MINUTE = 600;
const NAME_LOOKUP_DELAY = 5000; // 5 seconds between lookups (more conservative due to rate limiting)
const MAX_LOOKUP_RETRIES = 3;
const LOOKUP_BACKOFF_MULTIPLIER = 2;
const AT_FERRY_POLL_INTERVAL = 15000; // 15 seconds

// Circuit breaker for VesselFinder API
let circuitBreakerState = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
let failureCount = 0;
let lastFailureTime = null;
const FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_TIMEOUT = 300000; // 5 minutes

// Sanitize log input to prevent log injection
function sanitizeLogInput(input) {
  if (typeof input !== 'string') return String(input);
  return input.replace(/[\r\n\t]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

// Load API keys from S3
async function loadApiKeys() {
  const cached = apiKeyCache.get('keys');
  if (cached && Date.now() - cached.timestamp < 3600000) return cached.data;
  
  if (!CONFIG_BUCKET) {
    console.warn('CONFIG_BUCKET not set, using public mode');
    const config = { aisstream: {}, users: {}, _publicMode: true };
    apiKeyCache.set('keys', { data: config, timestamp: Date.now() });
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
    
    apiKeyCache.set('keys', { data: keys, timestamp: Date.now() });
    return keys;
  } catch (error) {
    console.error('Failed to load API keys from S3:', sanitizeLogInput(error.message || ''));
    const config = { aisstream: {}, users: {}, _publicMode: true };
    apiKeyCache.set('keys', { data: config, timestamp: Date.now() });
    return config;
  }
}

// Get AISStream API key
async function getAISStreamKey() {
  const keys = await loadApiKeys();
  return keys.aisstream?.primary?.key || keys.aisstream?.backup?.key;
}

// Get Auckland Transport API key
async function getATApiKey() {
  const keys = await loadApiKeys();
  return keys.aucklandTransport?.key;
}

// Fetch Auckland Transport ferry positions
async function fetchATFerryPositions() {
  const atApiKey = await getATApiKey();
  if (!atApiKey) {
    if (DEBUG) console.log('No Auckland Transport API key available, skipping ferry fetch');
    return null;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    const response = await fetch('https://api.at.govt.nz/realtime/legacy/ferrypositions', {
      signal: controller.signal,
      headers: {
        'Ocp-Apim-Subscription-Key': atApiKey,
        'Cache-Control': 'no-cache'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.warn(`AT Ferry API returned ${response.status}`);
      return null;
    }
    
    const data = await response.json();
    
    if (data.status !== 'OK' || !Array.isArray(data.response)) {
      console.warn('Invalid AT Ferry API response format:', { status: data.status, responseType: typeof data.response });
      return null;
    }
    
    console.log(`Fetched ${data.response.length} ferry positions from AT API`);
    if (DEBUG && data.response.length > 0) {
      console.log('Sample ferry data:', JSON.stringify(data.response[0], null, 2));
    }
    return data.response;
    
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('AT Ferry API request timeout');
    } else {
      console.warn('AT Ferry API request failed:', sanitizeLogInput(String(error.message)));
    }
    return null;
  }
}

// Process AT ferry data into vessel cache
function processATFerryData(ferries) {
  if (!Array.isArray(ferries)) {
    console.warn('processATFerryData: ferries is not an array:', typeof ferries);
    return;
  }
  
  console.log(`Processing ${ferries.length} AT ferry records`);
  let processed = 0;
  let skipped = 0;
  
  for (const ferry of ferries) {
    try {
      const mmsi = ferry.mmsi;
      if (!mmsi || mmsi < 100000000 || mmsi > 999999999) {
        if (DEBUG) console.log(`Skipping ferry with invalid MMSI: ${mmsi}`);
        skipped++;
        continue;
      }
      
      // Convert timestamp to AIS format
      const timestamp = new Date(ferry.timestamp).toISOString();
      
      let vessel = vesselCache.get(mmsi) || {
        MMSI: mmsi,
        NAME: '',
        CALLSIGN: '',
        DEST: '',
        TYPE: 60, // Passenger ship (ferry)
        IMO: null,
        DRAUGHT: null,
        A: null,
        B: null,
        C: null,
        D: null,
        ETA: null,
        _rateOfTurn: null,
        _positionAccuracy: null,
        _timestamp: null,
        _aisVersion: null,
        _fixType: null,
        _valid: null,
        _messageType: 'ATFerryPosition',
        _nameSource: null,
        _nameLastLookup: null,
        _lookupCountry: null,
        _lookupGrossTonnage: null,
        _lookupDeadweight: null,
        _lookupYearBuilt: null,
        _lookupTypeText: null
      };
      
      // Always use AT ferry position data (polled every 30s, more current)
      vessel.TIME = new Date(ferry.timestamp).toISOString().replace('T', ' ').replace('Z', ' UTC');
      vessel.LONGITUDE = ferry.lng;
      vessel.LATITUDE = ferry.lat;
      vessel.COG = 0; // AT API doesn't provide movement data, use 0 instead of null
      vessel.SOG = 0; // Use 0 instead of null for better ETL compatibility
      vessel.HEADING = 0; // Use 0 instead of null
      vessel.NAVSTAT = 5; // Moored (appropriate for ferries at terminals)
      vessel._messageType = 'ATFerryPosition';
      vessel.lastUpdate = new Date();
      
      // Set ferry-specific data
      if (ferry.vessel && ferry.vessel.trim()) {
        vessel.NAME = ferry.vessel.trim();
        vessel._nameSource = 'at_api';
      }
      if (ferry.callsign && ferry.callsign.trim()) {
        vessel.CALLSIGN = ferry.callsign.trim();
      }
      if (ferry.operator && ferry.operator.trim()) {
        vessel._atOperator = ferry.operator.trim();
      }
      if (ferry.eta && ferry.eta.trim()) {
        vessel.ETA = ferry.eta.trim();
      }
      
      vessel.TYPE = 60; // Ferry type
      
      vesselCache.set(mmsi, vessel);
      processed++;
      
      console.log(`✅ Updated AT ferry: MMSI ${mmsi}, Name: "${vessel.NAME}", Operator: ${vessel._atOperator}`);
      
    } catch (error) {
      console.warn('Error processing AT ferry data:', sanitizeLogInput(String(error.message)));
      skipped++;
    }
  }
  
  console.log(`AT ferry processing complete: ${processed} processed, ${skipped} skipped`);
}

// Validate user API key
async function validateUserApiKey(providedKey) {
  if (!providedKey) return { valid: false, reason: 'No API key provided' };
  
  const keys = await loadApiKeys();
  
  if (keys._publicMode) {
    return { valid: true, keyName: 'public', rateLimit: null };
  }
  
  const userKeys = keys.users || {};
  
  for (const [keyName, keyConfig] of Object.entries(userKeys)) {
    if (keyConfig.enabled && keyConfig.key === providedKey) {
      return { valid: true, keyName, rateLimit: keyConfig.rateLimit };
    }
  }
  
  return { valid: false, reason: 'Invalid API key' };
}

// Cache cleanup to prevent memory issues
function cleanupCaches() {
  // Clean up rate limit cache
  if (rateLimitCache.size > MAX_RATE_LIMIT_CACHE_SIZE) {
    const entries = Array.from(rateLimitCache.entries());
    entries.sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]));
    rateLimitCache.clear();
    entries.slice(0, MAX_RATE_LIMIT_CACHE_SIZE / 2).forEach(([k, v]) => rateLimitCache.set(k, v));
  }
  
  // Clean up vessel cache if too large
  if (vesselCache.size > MAX_VESSEL_CACHE_SIZE) {
    const entries = Array.from(vesselCache.entries());
    entries.sort((a, b) => b[1].lastUpdate - a[1].lastUpdate);
    vesselCache.clear();
    entries.slice(0, MAX_VESSEL_CACHE_SIZE * 0.8).forEach(([k, v]) => vesselCache.set(k, v));
  }
}

// Rate limiting
function checkRateLimit(identifier, limit = RATE_LIMIT_PER_MINUTE) {
  const key = `rate_${identifier}`;
  const now = Date.now();
  const windowStart = now - 60000; // 1 minute window
  
  let requests = rateLimitCache.get(key) || [];
  requests = requests.filter(time => time > windowStart);
  
  if (requests.length >= limit) {
    return { allowed: false, message: `Rate limit exceeded (${limit}/min)` };
  }
  
  requests.push(now);
  rateLimitCache.set(key, requests);
  return { allowed: true };
}

// Load cache from disk
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const cached = JSON.parse(data);
      let queuedForLookup = 0;
      
      for (const [mmsi, vessel] of Object.entries(cached)) {
        vessel.lastUpdate = new Date(vessel.lastUpdate);
        // Fix date parsing for _nameLastLookup
        if (vessel._nameLastLookup && typeof vessel._nameLastLookup === 'string') {
          vessel._nameLastLookup = new Date(vessel._nameLastLookup);
        }
        vesselCache.set(parseInt(mmsi), vessel);
        
        // Queue existing vessels that need lookup
        const needsLookup = (
          // Class B vessels without names
          (!vessel.NAME && (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport')) ||
          // Any vessel without type information
          (vessel.TYPE === null && vessel._messageType !== 'AidsToNavigationReport')
        );
        
        if (needsLookup) {
          // For startup, be more aggressive about queuing lookups for vessels with TYPE=null
          // even if they were looked up recently, since the lookup logic was just fixed
          const shouldQueue = !vessel._nameLastLookup || 
                             vessel.TYPE === null || 
                             (!vessel.NAME && (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport'));
          
          if (shouldQueue) {
            queueNameLookup(parseInt(mmsi));
            queuedForLookup++;
          }
        }
      }
      
      console.log(`Loaded ${vesselCache.size} vessels from cache, queued ${queuedForLookup} for lookup`);
      
      // Diagnostic: Show some Class B vessels that need lookups
      let classBCount = 0;
      let classBWithoutNames = 0;
      for (const [mmsi, vessel] of vesselCache.entries()) {
        if (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport') {
          classBCount++;
          if (!vessel.NAME) {
            classBWithoutNames++;
            if (classBWithoutNames <= 5) { // Show first 5 examples
              const lastLookup = vessel._nameLastLookup ? 
                (vessel._nameLastLookup instanceof Date ? vessel._nameLastLookup.toISOString() : vessel._nameLastLookup) : 
                'never';
              console.log(`  Example Class B without name: MMSI ${mmsi}, last lookup: ${lastLookup}`);
            }
          }
        }
      }
      console.log(`Class B vessels: ${classBCount} total, ${classBWithoutNames} without names`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.info('Cache file does not exist, starting with empty cache');
    } else if (error instanceof SyntaxError) {
      console.error('Cache file contains invalid JSON:', sanitizeLogInput(error.message));
    } else {
      console.error('Failed to load cache:', sanitizeLogInput(error.message));
    }
  }
}

// Save cache to disk
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const cacheObj = Object.fromEntries(vesselCache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheObj));
    if (DEBUG) console.log(`Saved ${vesselCache.size} vessels to cache`);
  } catch (error) {
    console.warn('Failed to save cache:', sanitizeLogInput(error.message || ''));
  }
}

// WebSocket connection state
let wsConnection = null;
let reconnectAttempts = 0;
let pingInterval = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000;

// Connect to AISStream WebSocket
async function connectToAISStream() {
  const apiKey = await getAISStreamKey();
  if (!apiKey) {
    console.error('No AISStream API key available');
    setTimeout(connectToAISStream, 30000); // Retry in 30 seconds
    return;
  }
  
  // Close existing connection if any
  if (wsConnection) {
    wsConnection.removeAllListeners();
    wsConnection.close();
    wsConnection = null;
  }
  
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  
  const boundingBox = [[-48.0, 166.0], [-34.0, 179.0]]; // NZ region
  
  const subscriptionMessage = {
    APIKey: apiKey,
    BoundingBoxes: [boundingBox],
    FilterMessageTypes: ["PositionReport", "ShipStaticData", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "StaticDataReport", "AidsToNavigationReport"]
  };

  wsConnection = new WebSocket('wss://stream.aisstream.io/v0/stream');
  
  wsConnection.on('open', () => {
    console.log('Connected to AISStream');
    reconnectAttempts = 0;
    wsConnection.send(JSON.stringify(subscriptionMessage));
    
    // Set up ping interval to keep connection alive
    pingInterval = setInterval(() => {
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.ping();
      }
    }, 30000); // Ping every 30 seconds
  });

  wsConnection.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      processAISMessage(message);
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.warn('Invalid JSON in AIS message:', sanitizeLogInput(error.message || ''));
      } else {
        console.warn('Failed to process AIS message:', sanitizeLogInput(error.message || ''));
      }
      if (DEBUG) console.warn('Raw data:', sanitizeLogInput(data.toString().substring(0, 200)));
    }
  });
  
  wsConnection.on('ping', () => {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
      wsConnection.pong();
    }
  });
  
  wsConnection.on('pong', () => {
    if (DEBUG) console.log('Received pong from AISStream');
  });

  wsConnection.on('error', (error) => {
    console.error('WebSocket error:', sanitizeLogInput(String(error.message || error)));
    scheduleReconnect();
  });

  wsConnection.on('close', (code, reason) => {
    console.log(`WebSocket connection closed (code: ${code}, reason: ${sanitizeLogInput(String(reason || 'unknown'))})`);
    
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    
    // Don't reconnect if it was a normal closure or authentication error
    if (code === 1000 || code === 1008) {
      console.log('Connection closed normally or due to auth error, not reconnecting');
      return;
    }
    
    scheduleReconnect();
  });
}

// Schedule reconnection with exponential backoff
function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping reconnection.`);
    return;
  }
  
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), 60000); // Max 1 minute
  reconnectAttempts++;
  
  console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  setTimeout(connectToAISStream, delay);
}

// Vessel type mapping from VesselFinder text to AIS codes
const VESSEL_TYPE_MAPPING = {
  'cargo ship': 70,
  'cargo': 70,
  'container ship': 70,
  'bulk carrier': 70,
  'general cargo': 70,
  'tanker': 80,
  'oil tanker': 80,
  'chemical tanker': 80,
  'gas tanker': 80,
  'passenger ship': 60,
  'passenger': 60,
  'cruise ship': 60,
  'ferry': 60,
  'ro-ro passenger': 60,
  'fishing vessel': 30,
  'fishing': 30,
  'fishing support vessel': 30,
  'tug': 52,
  'tugboat': 52,
  'pilot vessel': 50,
  'pilot': 50,
  'pleasure craft': 37,
  'yacht': 37,
  'sailing vessel': 36,
  'sailing': 36,
  'military': 35,
  'naval': 35,
  'warship': 35,
  'research vessel': 58,
  'research': 58,
  'supply vessel': 79,
  'offshore supply': 79,
  'platform supply': 79,
  'anchor handling': 79,
  'dredger': 33,
  'diving vessel': 33,
  'law enforcement': 55,
  'patrol vessel': 55,
  'rescue vessel': 51,
  'search and rescue': 51,
  'icebreaker': 52,
  'cable layer': 57,
  'pipe layer': 57,
  // Additional types found from analysis
  'towing vessel': 52,
  'hsc': 40, // High speed craft
  'wig': 20, // Wing in ground
  'dredging or uw ops': 33,
  'sar': 51, // Search and rescue
  'other type': 0, // Not available
  'unknown': 0 // Not available
};

// Track unknown vessel types for future mapping
const unknownVesselTypes = new Set();

// Check circuit breaker state
function checkCircuitBreaker() {
  if (circuitBreakerState === 'OPEN') {
    if (Date.now() - lastFailureTime > CIRCUIT_BREAKER_TIMEOUT) {
      circuitBreakerState = 'HALF_OPEN';
      console.log('🔄 Circuit breaker moving to HALF_OPEN state');
    } else {
      return false; // Circuit is open, don't make requests
    }
  }
  return true;
}

// Record API success/failure for circuit breaker
function recordApiResult(success) {
  if (success) {
    if (circuitBreakerState === 'HALF_OPEN') {
      circuitBreakerState = 'CLOSED';
      failureCount = 0;
      console.log('✅ Circuit breaker reset to CLOSED state');
    }
  } else {
    failureCount++;
    lastFailureTime = Date.now();
    
    if (failureCount >= FAILURE_THRESHOLD && circuitBreakerState === 'CLOSED') {
      circuitBreakerState = 'OPEN';
      console.warn(`🚫 Circuit breaker OPEN - too many failures (${failureCount}). Pausing lookups for ${CIRCUIT_BREAKER_TIMEOUT/1000}s`);
    }
  }
}

// Enhanced vessel lookup with retry logic
async function lookupVesselData(mmsi, retryCount = 0) {
  // Check circuit breaker
  if (!checkCircuitBreaker()) {
    if (DEBUG) console.log(`Circuit breaker OPEN - skipping lookup for MMSI ${mmsi}`);
    return null;
  }
  
  try {
    // Validate MMSI to prevent SSRF
    if (!Number.isInteger(mmsi) || mmsi < 100000000 || mmsi > 999999999) {
      throw new Error('Invalid MMSI format');
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
    
    let data;
    try {
      const response = await fetch(`https://www.vesselfinder.com/api/pub/click/${mmsi}`, {
        signal: controller.signal,
        headers: { 
          'User-Agent': 'Mozilla/5.0 (compatible; AIS-Proxy/1.0)',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache'
        }
      });
      
      clearTimeout(timeoutId);
      
      if (response.status === 429 || response.status === 503) {
        // Rate limited or service unavailable - retry with exponential backoff
        if (retryCount < MAX_LOOKUP_RETRIES) {
          const delay = NAME_LOOKUP_DELAY * Math.pow(LOOKUP_BACKOFF_MULTIPLIER, retryCount);
          console.warn(`⏳ Rate limited for MMSI ${mmsi}, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_LOOKUP_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return await lookupVesselData(mmsi, retryCount + 1);
        } else {
          console.warn(`❌ Max retries exceeded for MMSI ${mmsi} due to rate limiting`);
          throw new Error(`Rate limited after ${MAX_LOOKUP_RETRIES} attempts`);
        }
      }
      
      if (!response.ok) {
        console.warn(`⚠️ VesselFinder API returned ${response.status} for MMSI ${mmsi}`);
        return null;
      }
      
      data = await response.json();
      
      // Log successful response with full data for debugging
      console.log(`✅ VesselFinder response for MMSI ${mmsi}:`, JSON.stringify(data));
      
      // Record successful API call
      recordApiResult(true);
      
      // Check if we have a name - VesselFinder sometimes returns data without name
      if (!data.name || (typeof data.name === 'string' && data.name.trim() === '')) {
        console.log(`⚠ No name found for MMSI ${mmsi} in VesselFinder response:`, JSON.stringify(data));
        return null;
      }
      
      console.log(`✅ Found vessel data for MMSI ${mmsi}: name="${data.name}", type="${data.type || 'unknown'}"`);
      
    } finally {
      clearTimeout(timeoutId);
    }
    
    // Map vessel type
    let aisType = null;
    if (data.type) {
      const typeKey = data.type.toLowerCase();
      aisType = VESSEL_TYPE_MAPPING[typeKey];
      
      // Handle undefined vs null - if not found in mapping, set to null
      if (aisType === undefined) aisType = null;
      
      // Track unknown types for future mapping
      if (aisType === null && !unknownVesselTypes.has(typeKey)) {
        unknownVesselTypes.add(typeKey);
        console.warn(`Unknown vessel type from VesselFinder: "${sanitizeLogInput(String(data.type || ''))}" (${sanitizeLogInput(String(typeKey))})`);
      }
    }
    
    const result = {
      name: data.name.trim(),
      type: aisType,
      imo: data.imo || null,
      country: data.country || null,
      grossTonnage: data.gt || null,
      deadweight: data.dw || null,
      yearBuilt: data.y || null,
      typeText: data.type || null
    };
    
    console.log(`✅ Returning vessel data for MMSI ${mmsi}:`, JSON.stringify(result));
    return result;
  } catch (error) {
    // Record failed API call
    recordApiResult(false);
    
    if (error.name === 'AbortError') {
      console.warn(`⏰ Lookup timeout for MMSI ${mmsi}`);
    } else if (error.message.includes('Rate limited')) {
      console.warn(`🚫 ${error.message} for MMSI ${mmsi}`);
    } else {
      console.warn(`❌ Vessel lookup failed for MMSI ${mmsi}:`, sanitizeLogInput(String(error.message)));
    }
    return null;
  }
}

// Process name lookup queue
async function processNameLookupQueue() {
  if (nameLookupInProgress || nameLookupQueue.length === 0) return;
  
  nameLookupInProgress = true;
  
  while (nameLookupQueue.length > 0) {
    const mmsi = nameLookupQueue.shift();
    const vessel = vesselCache.get(mmsi);
    
    if (!vessel) {
      console.warn(`⚠ Vessel ${mmsi} not found in cache during lookup processing`);
      continue; // Skip if vessel gone
    }
    
    console.log(`⚙️ Processing lookup for MMSI ${mmsi} (${nameLookupQueue.length} remaining in queue)`);
    
    // Skip if vessel already has both name and type, or if we only need name but already have it
    const needsName = !vessel.NAME && (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport');
    const needsType = vessel.TYPE === null && vessel._messageType !== 'AidsToNavigationReport';
    
    if (!needsName && !needsType) {
      console.log(`✓ MMSI ${mmsi} already has required data (name: "${vessel.NAME}", type: ${vessel.TYPE})`);
      continue;
    }
    
    if (DEBUG) console.log(`Looking up MMSI ${mmsi}: needs name=${needsName}, needs type=${needsType}`);
    
    let vesselData;
    let lookupError = null;
    try {
      vesselData = await lookupVesselData(mmsi);
    } catch (error) {
      lookupError = error;
      console.warn(`⚠ Vessel lookup failed for MMSI ${mmsi}:`, sanitizeLogInput(String(error.message)));
      vesselData = null;
    }
    if (vesselData) {
      console.log(`🔄 Updating vessel cache for MMSI ${mmsi} with lookup data:`, JSON.stringify(vesselData));
      
      // Update name if missing
      if (!vessel.NAME && vesselData.name) {
        vessel.NAME = vesselData.name;
        vessel._nameSource = 'lookup';
        console.log(`✓ Updated NAME for MMSI ${mmsi}: "${sanitizeLogInput(String(vesselData.name))}"`);
      }
      
      // Update type if missing
      if (vessel.TYPE === null && vesselData.type !== null) {
        vessel.TYPE = vesselData.type;
        console.log(`✓ Updated TYPE for MMSI ${mmsi}: ${vesselData.type} (${sanitizeLogInput(String(vesselData.typeText))})`);
      }
      if (!vessel.IMO && vesselData.imo) vessel.IMO = vesselData.imo;
      
      // Store additional lookup data
      vessel._lookupCountry = vesselData.country;
      vessel._lookupGrossTonnage = vesselData.grossTonnage;
      vessel._lookupDeadweight = vesselData.deadweight;
      vessel._lookupYearBuilt = vesselData.yearBuilt;
      vessel._lookupTypeText = vesselData.typeText;
      
      // Force cache update
      vesselCache.set(mmsi, vessel);
      console.log(`✅ Cache updated for MMSI ${mmsi}: NAME="${vessel.NAME}", TYPE=${vessel.TYPE}`);
      
      if (DEBUG) console.log(`Enhanced data for MMSI ${mmsi}: ${sanitizeLogInput(String(vesselData.name))} (${sanitizeLogInput(String(vesselData.typeText))}) - AIS type: ${vesselData.type}`);
    } else {
      console.warn(`⚠ No data found for MMSI ${mmsi} in VesselFinder - vesselData is:`, vesselData);
      console.warn(`⚠ Lookup error was:`, lookupError ? lookupError.message : 'none');
    }
    
    // Only update lookup timestamp if we got a successful response or a definitive "not found"
    // Don't update if there was a network/API error, so we can retry sooner
    if (vesselData || !lookupError) {
      vessel._nameLastLookup = new Date();
    } else {
      // For errors, set a shorter retry interval
      vessel._nameLastLookup = new Date(Date.now() - 82800000); // 23 hours ago, so retry in 1 hour
      if (DEBUG) console.log(`Setting shorter retry interval for MMSI ${mmsi} due to lookup error`);
    }
    
    // Rate limit: wait between requests
    if (nameLookupQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, NAME_LOOKUP_DELAY));
    }
  }
  
  nameLookupInProgress = false;
}

// Queue vessel for name lookup
function queueNameLookup(mmsi) {
  if (!nameLookupQueue.includes(mmsi)) {
    nameLookupQueue.push(mmsi);
    console.log(`→ Queued MMSI ${mmsi} for name lookup (queue length: ${nameLookupQueue.length})`);
    // Process queue in next tick to avoid blocking
    setImmediate(processNameLookupQueue);
  } else {
    if (DEBUG) console.log(`MMSI ${mmsi} already in lookup queue`);
  }
}



function processAISMessage(message) {
  try {
    // Validate message structure
    if (!message.MetaData?.MMSI || !message.MessageType || !message.Message) {
      if (DEBUG) console.warn('Invalid message structure:', message);
      return;
    }
    
    const mmsi = message.MetaData.MMSI;
    const messageType = message.MessageType;
    
    // Validate coordinates
    const lat = message.MetaData.latitude;
    const lon = message.MetaData.longitude;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      if (DEBUG) console.warn(`Invalid coordinates for MMSI ${mmsi}: ${lat}, ${lon}`);
      return;
    }
    
    let vessel = vesselCache.get(mmsi) || {
      MMSI: mmsi,
      NAME: '',
      CALLSIGN: '',
      DEST: '',
      TYPE: null,
      IMO: null,
      DRAUGHT: null,
      A: null,
      B: null,
      C: null,
      D: null,
      ETA: null,
      // Internal fields (not exposed in AISHub API)
      _rateOfTurn: null,
      _positionAccuracy: null,
      _timestamp: null,
      _aisVersion: null,
      _fixType: null,
      _valid: null,
      _messageType: null,
      _nameSource: null, // 'ais' | 'lookup' | null
      _nameLastLookup: null,
      _lookupCountry: null,
      _lookupGrossTonnage: null,
      _lookupDeadweight: null,
      _lookupYearBuilt: null,
      _lookupTypeText: null
    };
    
    // Update common fields
    vessel.MMSI = mmsi;
    vessel.TIME = new Date(message.MetaData.time_utc).toISOString().replace('T', ' ').replace('Z', ' UTC');
    vessel.LONGITUDE = lon;
    vessel.LATITUDE = lat;
    vessel.lastUpdate = new Date();
    vessel._messageType = messageType;
    
    // Process position reports (Class A)
    if (message.Message.PositionReport) {
      const pos = message.Message.PositionReport;
      
      // Validate message if Valid field exists
      if (pos.Valid !== undefined && !pos.Valid) {
        if (DEBUG) console.warn(`Invalid position report for MMSI ${mmsi}`);
        return;
      }
      
      vessel.COG = pos.Cog;
      vessel.SOG = pos.Sog;
      vessel.HEADING = pos.TrueHeading;
      vessel.NAVSTAT = pos.NavigationalStatus;
      
      // Store additional internal fields
      vessel._rateOfTurn = pos.RateOfTurn;
      vessel._positionAccuracy = pos.PositionAccuracy;
      vessel._timestamp = pos.Timestamp;
      vessel._valid = pos.Valid;
    }
    
    // Process Class B position reports
    if (message.Message.StandardClassBPositionReport || message.Message.ExtendedClassBPositionReport) {
      const pos = message.Message.StandardClassBPositionReport || message.Message.ExtendedClassBPositionReport;
      
      // Validate message if Valid field exists
      if (pos.Valid !== undefined && !pos.Valid) {
        if (DEBUG) console.warn(`Invalid Class B position report for MMSI ${mmsi}`);
        return;
      }
      
      vessel.COG = pos.Cog;
      vessel.SOG = pos.Sog;
      vessel.HEADING = pos.TrueHeading;
      // Class B vessels don't have NavigationalStatus, set to null
      vessel.NAVSTAT = null;
      
      // Store additional internal fields
      vessel._positionAccuracy = pos.PositionAccuracy;
      vessel._timestamp = pos.Timestamp;
      vessel._valid = pos.Valid;
    }
    
    // Process static data
    if (message.Message.ShipStaticData) {
      const static_data = message.Message.ShipStaticData;
      
      // Validate message if Valid field exists
      if (static_data.Valid !== undefined && !static_data.Valid) {
        if (DEBUG) console.warn(`Invalid static data for MMSI ${mmsi}`);
        return;
      }
      
      if (static_data.CallSign) vessel.CALLSIGN = static_data.CallSign.trim();
      if (static_data.Destination) vessel.DEST = static_data.Destination.trim();
      if (static_data.Type !== undefined) vessel.TYPE = static_data.Type;
      if (static_data.ImoNumber !== undefined) vessel.IMO = static_data.ImoNumber;
      if (static_data.MaximumStaticDraught !== undefined) vessel.DRAUGHT = static_data.MaximumStaticDraught;
      
      if (static_data.Name) {
        vessel.NAME = static_data.Name.trim();
        vessel._nameSource = 'ais';
      }
      
      if (static_data.Dimension) {
        if (static_data.Dimension.A !== undefined) vessel.A = static_data.Dimension.A;
        if (static_data.Dimension.B !== undefined) vessel.B = static_data.Dimension.B;
        if (static_data.Dimension.C !== undefined) vessel.C = static_data.Dimension.C;
        if (static_data.Dimension.D !== undefined) vessel.D = static_data.Dimension.D;
      }
      
      if (static_data.Eta) {
        const eta = static_data.Eta;
        const month = eta.Month?.toString().padStart(2, '0') || '00';
        const day = eta.Day?.toString().padStart(2, '0') || '00';
        const hour = eta.Hour?.toString().padStart(2, '0') || '00';
        const minute = eta.Minute?.toString().padStart(2, '0') || '00';
        vessel.ETA = `${month}/${day} ${hour}:${minute}`;
      }
      
      // Store additional internal fields
      vessel._aisVersion = static_data.AisVersion;
      vessel._fixType = static_data.FixType;
      vessel._valid = static_data.Valid;
    }
    
    // Process Class B static data (Message Type 24)
    if (message.Message.StaticDataReport) {
      const static_data = message.Message.StaticDataReport;
      
      // Validate message if Valid field exists
      if (static_data.Valid !== undefined && !static_data.Valid) {
        if (DEBUG) console.warn(`Invalid Class B static data for MMSI ${mmsi}`);
        return;
      }
      
      // Message Type 24A contains name and call sign
      if (static_data.PartNumber === 0) {
        if (static_data.Name) {
          vessel.NAME = static_data.Name.trim();
          vessel._nameSource = 'ais';
          console.log(`📡 Received Class B name from AIS for MMSI ${mmsi}: "${sanitizeLogInput(String(static_data.Name.trim()))}"`);
        }
        if (static_data.CallSign) {
          vessel.CALLSIGN = static_data.CallSign.trim();
        }
      }
      
      // Message Type 24B contains type and dimensions
      if (static_data.PartNumber === 1) {
        if (static_data.Type !== undefined) {
          vessel.TYPE = static_data.Type;
          console.log(`📡 Received Class B type from AIS for MMSI ${mmsi}: ${static_data.Type}`);
        }
        
        if (static_data.Dimension) {
          if (static_data.Dimension.A !== undefined) vessel.A = static_data.Dimension.A;
          if (static_data.Dimension.B !== undefined) vessel.B = static_data.Dimension.B;
          if (static_data.Dimension.C !== undefined) vessel.C = static_data.Dimension.C;
          if (static_data.Dimension.D !== undefined) vessel.D = static_data.Dimension.D;
        }
      }
      
      // Store additional internal fields
      vessel._valid = static_data.Valid;
    }
    
    // Process navigation aids
    if (message.Message.AidsToNavigationReport) {
      const nav_aid = message.Message.AidsToNavigationReport;
      
      // Validate message if Valid field exists
      if (nav_aid.Valid !== undefined && !nav_aid.Valid) {
        if (DEBUG) console.warn(`Invalid navigation aid for MMSI ${mmsi}`);
        return;
      }
      
      if (nav_aid.Name) {
        vessel.NAME = nav_aid.Name.trim();
        vessel._nameSource = 'ais';
      }
      if (nav_aid.Type !== undefined) vessel.TYPE = nav_aid.Type;
      
      // Navigation aids don't move, so set movement fields to null/zero
      vessel.COG = null;
      vessel.SOG = 0;
      vessel.HEADING = null;
      vessel.NAVSTAT = null;
      
      if (nav_aid.Dimension) {
        if (nav_aid.Dimension.A !== undefined) vessel.A = nav_aid.Dimension.A;
        if (nav_aid.Dimension.B !== undefined) vessel.B = nav_aid.Dimension.B;
        if (nav_aid.Dimension.C !== undefined) vessel.C = nav_aid.Dimension.C;
        if (nav_aid.Dimension.D !== undefined) vessel.D = nav_aid.Dimension.D;
      }
      
      // Store additional internal fields
      vessel._positionAccuracy = nav_aid.PositionAccuracy;
      vessel._timestamp = nav_aid.Timestamp;
      vessel._valid = nav_aid.Valid;
    }
    
    vesselCache.set(mmsi, vessel);
    
    // Queue lookup for vessels missing name or type information
    const needsLookup = (
      // Class B vessels without names
      (!vessel.NAME && (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport')) ||
      // Any vessel without type information
      (vessel.TYPE === null && vessel._messageType !== 'AidsToNavigationReport')
    );
    
    if (needsLookup) {
      // More aggressive retry for vessels that failed lookup or have no data
      const retryInterval = vessel._nameLastLookup ? 
        (vessel.NAME || vessel.TYPE !== null ? 86400000 : 3600000) : // 24h if has some data, 1h if no data
        0; // Immediate if never looked up
      
      const retryTime = new Date(Date.now() - retryInterval);
      
      if (!vessel._nameLastLookup || vessel._nameLastLookup < retryTime) {
        if (DEBUG) console.log(`Queueing lookup for MMSI ${mmsi}: NAME="${sanitizeLogInput(String(vessel.NAME || ''))}", TYPE=${vessel.TYPE}, messageType=${sanitizeLogInput(String(vessel._messageType || ''))}, lastLookup=${vessel._nameLastLookup ? vessel._nameLastLookup.toISOString() : 'never'}`);
        queueNameLookup(mmsi);
      } else {
        if (DEBUG) console.log(`Skipping lookup for MMSI ${mmsi}: last lookup was ${vessel._nameLastLookup.toISOString()}, next retry after ${new Date(vessel._nameLastLookup.getTime() + retryInterval).toISOString()}`);
      }
    }
    

    
    // Save cache occasionally
    if (Math.random() < 0.01) saveCache();
    
  } catch (error) {
    console.warn('Error processing AIS message:', sanitizeLogInput(String(error.message)));
    if (DEBUG) console.warn('Message:', sanitizeLogInput(JSON.stringify(message).substring(0, 200)));
  }
}

// Clean up old vessels every 5 minutes
setInterval(() => {
  const oneHourAgo = new Date(Date.now() - 3600000);
  let removed = 0;
  let classA = 0, classB = 0, navigationAids = 0, unknown = 0;
  
  for (const [mmsi, vessel] of vesselCache.entries()) {
    if (vessel.lastUpdate < oneHourAgo) {
      vesselCache.delete(mmsi);
      removed++;
    } else {
      // Count vessel types for statistics
      if (vessel._messageType === 'PositionReport') classA++;
      else if (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport') classB++;
      else if (vessel._messageType === 'AidsToNavigationReport') navigationAids++;
      else unknown++;
    }
  }
  
  // Clean up caches to prevent memory issues
  cleanupCaches();
  
  if (removed > 0) {
    console.log(`Cleaned up ${removed} old vessels. Active: ${classA} Class A, ${classB} Class B, ${navigationAids} nav aids, ${unknown} other`);
    saveCache();
  } else if (DEBUG) {
    console.log(`Vessel count: ${classA} Class A, ${classB} Class B, ${navigationAids} nav aids, ${unknown} other`);
  }
}, 300000);

setInterval(saveCache, 600000);



// AISHub-compatible REST endpoint
app.get('/ais-proxy/ws.php', async (req, res) => {
  const { username, latmin, latmax, lonmin, lonmax } = req.query;
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ ERROR: true, MESSAGE: 'Unauthorized' });
  }
  
  // Check rate limit
  const rateLimitCheck = checkRateLimit(username || 'anonymous', keyValidation.rateLimit);
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({ ERROR: true, MESSAGE: rateLimitCheck.message });
  }
  
  // Use provided bounding box or default to NZ region
  const minLat = latmin ? parseFloat(latmin) : -48.0;
  const maxLat = latmax ? parseFloat(latmax) : -34.0;
  const minLon = lonmin ? parseFloat(lonmin) : 166.0;
  const maxLon = lonmax ? parseFloat(lonmax) : 179.0;

  const vessels = [];
  for (const vessel of vesselCache.values()) {
    if (vessel.LATITUDE >= minLat && vessel.LATITUDE <= maxLat &&
        vessel.LONGITUDE >= minLon && vessel.LONGITUDE <= maxLon) {
      
      // Filter out navigation aids from v1 API (AISHub compatibility)
      if (vessel._messageType === 'AidsToNavigationReport') {
        continue;
      }
      
      vessels.push({
        MMSI: vessel.MMSI,
        TIME: vessel.TIME,
        LONGITUDE: vessel.LONGITUDE,
        LATITUDE: vessel.LATITUDE,
        COG: vessel.COG,
        SOG: vessel.SOG,
        HEADING: vessel.HEADING,
        NAVSTAT: vessel.NAVSTAT,
        IMO: vessel.IMO,
        NAME: vessel.NAME || '',
        CALLSIGN: vessel.CALLSIGN || '',
        TYPE: vessel.TYPE,
        A: vessel.A,
        B: vessel.B,
        C: vessel.C,
        D: vessel.D,
        DRAUGHT: vessel.DRAUGHT,
        DEST: vessel.DEST || '',
        ETA: vessel.ETA
      });
    }
  }

  res.json({ VESSELS: vessels });
});

// Start AT ferry polling
let atFerryInterval = null;

async function startATFerryPolling() {
  if (atFerryInterval) return;
  
  console.log('Starting AT ferry position polling');
  
  // Check if we have AT API key
  const atApiKey = await getATApiKey();
  if (!atApiKey) {
    console.warn('⚠️ No Auckland Transport API key configured - ferry polling disabled');
    return;
  }
  console.log('✅ Auckland Transport API key configured');
  
  // Initial fetch
  fetchATFerryPositions().then(ferries => {
    if (ferries) processATFerryData(ferries);
  });
  
  // Set up interval
  atFerryInterval = setInterval(async () => {
    const ferries = await fetchATFerryPositions();
    if (ferries) processATFerryData(ferries);
  }, AT_FERRY_POLL_INTERVAL);
}

function stopATFerryPolling() {
  if (atFerryInterval) {
    clearInterval(atFerryInterval);
    atFerryInterval = null;
    console.log('Stopped AT ferry position polling');
  }
}

// Enhanced v2 API endpoint
app.get('/ais-proxy/v2/vessels', async (req, res) => {
  const { username, latmin, latmax, lonmin, lonmax, include } = req.query;
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized', message: keyValidation.reason });
  }
  
  // Check rate limit
  const rateLimitCheck = checkRateLimit(username || 'anonymous', keyValidation.rateLimit);
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded', message: rateLimitCheck.message });
  }
  
  // Parse include filter (default: vessels only)
  const includeTypes = include ? include.split(',') : ['vessels'];
  const includeVessels = includeTypes.includes('vessels') || includeTypes.includes('all');
  const includeNavAids = includeTypes.includes('navigation-aids') || includeTypes.includes('all');
  
  // Use provided bounding box or default to NZ region
  const minLat = latmin ? parseFloat(latmin) : -48.0;
  const maxLat = latmax ? parseFloat(latmax) : -34.0;
  const minLon = lonmin ? parseFloat(lonmin) : 166.0;
  const maxLon = lonmax ? parseFloat(lonmax) : 179.0;

  const vessels = [];
  let classA = 0, classB = 0, navigationAids = 0, other = 0;
  let oldestUpdate = new Date();
  let newestUpdate = new Date(0);
  
  for (const vessel of vesselCache.values()) {
    if (vessel.LATITUDE >= minLat && vessel.LATITUDE <= maxLat &&
        vessel.LONGITUDE >= minLon && vessel.LONGITUDE <= maxLon) {
      
      const isNavigationAid = vessel._messageType === 'AidsToNavigationReport';
      const isVessel = !isNavigationAid;
      
      // Apply filtering
      if ((isVessel && !includeVessels) || (isNavigationAid && !includeNavAids)) {
        continue;
      }
      
      // Count vessel types
      if (vessel._messageType === 'PositionReport') classA++;
      else if (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport') classB++;
      else if (vessel._messageType === 'AidsToNavigationReport') navigationAids++;
      else other++;
      
      // Track update times
      if (vessel.lastUpdate < oldestUpdate) oldestUpdate = vessel.lastUpdate;
      if (vessel.lastUpdate > newestUpdate) newestUpdate = vessel.lastUpdate;
      
      vessels.push({
        mmsi: vessel.MMSI,
        time: vessel.TIME,
        longitude: vessel.LONGITUDE,
        latitude: vessel.LATITUDE,
        cog: vessel.COG,
        sog: vessel.SOG,
        heading: vessel.HEADING,
        navstat: vessel.NAVSTAT,
        imo: vessel.IMO,
        name: vessel.NAME || '',
        callsign: vessel.CALLSIGN || '',
        type: vessel.TYPE,
        dimensions: {
          a: vessel.A,
          b: vessel.B,
          c: vessel.C,
          d: vessel.D
        },
        draught: vessel.DRAUGHT,
        destination: vessel.DEST || '',
        eta: vessel.ETA,
        // Enhanced fields
        rateOfTurn: vessel._rateOfTurn,
        positionAccuracy: vessel._positionAccuracy,
        timestamp: vessel._timestamp,
        messageType: vessel._messageType,
        valid: vessel._valid,
        lastUpdate: vessel.lastUpdate.toISOString(),
        // Easy identification
        category: isNavigationAid ? 'navigation-aid' : 'vessel',
        nameSource: vessel._nameSource,
        // AT Ferry specific data
        atOperator: vessel._atOperator || null,
        // Enriched data from lookup
        enrichedData: vessel._nameSource === 'lookup' ? {
          country: vessel._lookupCountry,
          grossTonnage: vessel._lookupGrossTonnage,
          deadweight: vessel._lookupDeadweight,
          yearBuilt: vessel._lookupYearBuilt,
          typeText: vessel._lookupTypeText
        } : null
      });
    }
  }

  res.json({
    vessels,
    metadata: {
      totalCount: vessels.length,
      categories: {
        vessels: classA + classB,
        navigationAids
      },
      vesselTypes: {
        classA,
        classB,
        navigationAids,
        other
      },
      filters: {
        applied: include || 'vessels',
        available: ['vessels', 'navigation-aids', 'all']
      },
      boundingBox: {
        minLatitude: minLat,
        maxLatitude: maxLat,
        minLongitude: minLon,
        maxLongitude: maxLon
      },
      dataFreshness: {
        oldestUpdate: vessels.length > 0 ? oldestUpdate.toISOString() : null,
        newestUpdate: vessels.length > 0 ? newestUpdate.toISOString() : null
      },
      generatedAt: new Date().toISOString(),
      apiVersion: '2.0'
    }
  });
});

app.get('/ais-proxy/health', async (req, res) => {
  try {
    const keys = await loadApiKeys();
    const enabledUserKeys = Object.values(keys.users || {}).filter(k => k.enabled).length;
    const hasAISStreamKey = !!(keys.aisstream?.primary?.key || keys.aisstream?.backup?.key);
    
    res.json({ 
      status: 'ok', 
      vessels: vesselCache.size,
      uptime: process.uptime(),
      user_keys_configured: enabledUserKeys,
      aisstream_key_configured: hasAISStreamKey,
      at_api_key_configured: !!(keys.aucklandTransport?.key),
      at_ferry_polling: !!atFerryInterval,
      public_mode: !!keys._publicMode,
      config_bucket: !!CONFIG_BUCKET,
      upload_clients_24h: Array.from(clientStatusCache.values())
        .filter(status => status.lastSeen > new Date(Date.now() - 24 * 60 * 60 * 1000)).length
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Health check failed'
    });
  }
});

// Manual vessel lookup endpoint for debugging
app.get('/ais-proxy/debug/lookup/:mmsi', async (req, res) => {
  const mmsi = parseInt(req.params.mmsi);
  const { username } = req.query;
  
  if (isNaN(mmsi)) {
    return res.status(400).json({ error: 'Invalid MMSI' });
  }
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    console.log(`Manual lookup requested for MMSI ${mmsi}`);
    const vesselData = await lookupVesselData(mmsi);
    
    const cachedVessel = vesselCache.get(mmsi);
    
    res.json({
      mmsi,
      lookupResult: vesselData,
      cachedVessel: cachedVessel ? {
        name: cachedVessel.NAME,
        type: cachedVessel.TYPE,
        nameSource: cachedVessel._nameSource,
        lastLookup: cachedVessel._nameLastLookup,
        messageType: cachedVessel._messageType,
        lookupData: {
          country: cachedVessel._lookupCountry,
          typeText: cachedVessel._lookupTypeText,
          grossTonnage: cachedVessel._lookupGrossTonnage
        }
      } : null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Lookup failed',
      message: sanitizeLogInput(String(error.message)),
      mmsi,
      timestamp: new Date().toISOString()
    });
  }
});

// Force lookup queue for specific MMSI
app.post('/ais-proxy/debug/queue-lookup/:mmsi', async (req, res) => {
  const mmsi = parseInt(req.params.mmsi);
  const { username } = req.query;
  
  if (isNaN(mmsi)) {
    return res.status(400).json({ error: 'Invalid MMSI' });
  }
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const vessel = vesselCache.get(mmsi);
  if (!vessel) {
    return res.status(404).json({ error: 'Vessel not found in cache' });
  }
  
  // Reset last lookup time to force a new lookup
  vessel._nameLastLookup = null;
  
  queueNameLookup(mmsi);
  
  res.json({
    message: `Queued lookup for MMSI ${mmsi}`,
    queueLength: nameLookupQueue.length,
    inProgress: nameLookupInProgress,
    timestamp: new Date().toISOString()
  });
});

// Debug endpoint to show AT ferry vessels in cache
app.get('/ais-proxy/debug/ferries', async (req, res) => {
  const { username } = req.query;
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const ferries = [];
  for (const [mmsi, vessel] of vesselCache.entries()) {
    if (vessel._messageType === 'ATFerryPosition') {
      ferries.push({
        mmsi: vessel.MMSI,
        name: vessel.NAME,
        operator: vessel._atOperator,
        latitude: vessel.LATITUDE,
        longitude: vessel.LONGITUDE,
        lastUpdate: vessel.lastUpdate,
        time: vessel.TIME
      });
    }
  }
  
  res.json({
    ferryCount: ferries.length,
    totalVessels: vesselCache.size,
    ferries: ferries.sort((a, b) => a.name.localeCompare(b.name)),
    timestamp: new Date().toISOString()
  });
});

// Manual AT ferry fetch endpoint for debugging
app.get('/ais-proxy/debug/fetch-ferries', async (req, res) => {
  const { username } = req.query;
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    console.log('Manual AT ferry fetch requested');
    const ferries = await fetchATFerryPositions();
    
    if (ferries) {
      const beforeCount = vesselCache.size;
      processATFerryData(ferries);
      const afterCount = vesselCache.size;
      
      res.json({
        success: true,
        ferriesReceived: ferries.length,
        vesselCacheBefore: beforeCount,
        vesselCacheAfter: afterCount,
        ferries: ferries.map(f => ({
          mmsi: f.mmsi,
          vessel: f.vessel,
          operator: f.operator,
          lat: f.lat,
          lng: f.lng,
          timestamp: f.timestamp
        })),
        timestamp: new Date().toISOString()
      });
    } else {
      res.json({
        success: false,
        message: 'Failed to fetch ferry data',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Ferry fetch failed',
      message: sanitizeLogInput(String(error.message)),
      timestamp: new Date().toISOString()
    });
  }
});

// AIS data upload endpoint (jsonais format)
app.post('/ais-proxy/jsonais/:apiKey', async (req, res) => {
  const apiKey = req.params.apiKey;
  const clientId = apiKey.slice(-4); // Last 4 characters for identification
  
  if (!apiKey || apiKey.length < 8) {
    return res.status(400).json({ error: 'Invalid API key format' });
  }
  
  // Validate API key (use existing user validation)
  const keyValidation = await validateUserApiKey(apiKey);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid API key' });
  }
  
  // Rate limiting for uploads
  const rateLimitCheck = checkRateLimit(`upload_${apiKey}`, 100); // 100 uploads per minute
  if (!rateLimitCheck.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded', message: rateLimitCheck.message });
  }
  
  try {
    const data = req.body;
    
    // Only accept JSONAIS protocol format (single object)
    if (Array.isArray(data)) {
      return res.status(400).json({ error: 'Invalid format', message: 'Expected JSONAIS protocol object, not array' });
    }
    
    const messages = [data];
    
    let processed = 0;
    let errors = 0;
    
    // Update client status
    clientStatusCache.set(clientId, {
      lastSeen: new Date(),
      totalMessages: (clientStatusCache.get(clientId)?.totalMessages || 0) + messages.length,
      lastMessageCount: messages.length,
      apiKey: apiKey
    });
    
    for (const message of messages) {
      try {
        // Convert jsonais format to AISStream-like format
        const aisMessage = convertJsonaisToAIS(message);
        if (aisMessage) {
          processAISMessage(aisMessage);
          processed++;
        } else {
          errors++;
        }
      } catch (error) {
        console.warn(`Error processing uploaded AIS message:`, sanitizeLogInput(String(error.message)));
        errors++;
      }
    }
    
    res.json({
      success: true,
      processed,
      errors,
      total: messages.length,
      clientId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('AIS upload error:', sanitizeLogInput(String(error.message)));
    res.status(500).json({
      error: 'Processing failed',
      message: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

// Convert JSONAIS protocol format to AISStream-compatible format
function convertJsonaisToAIS(jsonaisMessage) {
  try {
    // Only handle full JSONAIS protocol format with groups/msgs structure
    if (jsonaisMessage.groups && Array.isArray(jsonaisMessage.groups)) {
      for (const group of jsonaisMessage.groups) {
        if (group.msgs && Array.isArray(group.msgs)) {
          for (const msg of group.msgs) {
            if (!msg.mmsi || msg.lat === undefined || msg.lon === undefined) {
              continue;
            }
            
            const mmsi = parseInt(msg.mmsi);
            if (mmsi < 100000000 || mmsi > 999999999) {
              continue;
            }
            
            const timestamp = msg.rxtime ? 
              parseJsonaisTime(msg.rxtime) : 
              Math.floor(Date.now() / 1000);
            
            return {
              MetaData: {
                MMSI: mmsi,
                latitude: parseFloat(msg.lat),
                longitude: parseFloat(msg.lon),
                time_utc: new Date(timestamp * 1000).toISOString()
              },
              MessageType: 'PositionReport',
              Message: {
                PositionReport: {
                  Cog: msg.course !== undefined ? parseFloat(msg.course) : null,
                  Sog: msg.speed !== undefined ? parseFloat(msg.speed) : null,
                  TrueHeading: msg.heading !== undefined ? parseInt(msg.heading) : null,
                  NavigationalStatus: msg.status !== undefined ? parseInt(msg.status) : null,
                  Valid: true
                }
              }
            };
          }
        }
      }
    }
    
    return null;
  } catch (error) {
    console.warn('Error converting JSONAIS message:', sanitizeLogInput(String(error.message)));
    return null;
  }
}

// Parse JSONAIS time format (YYYYMMDDHHMMSS)
function parseJsonaisTime(timeStr) {
  if (!timeStr || timeStr.length !== 14) return undefined;
  const year = timeStr.substr(0, 4);
  const month = timeStr.substr(4, 2);
  const day = timeStr.substr(6, 2);
  const hour = timeStr.substr(8, 2);
  const minute = timeStr.substr(10, 2);
  const second = timeStr.substr(12, 2);
  return Math.floor(new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).getTime() / 1000);
}

// Client status endpoint
app.get('/ais-proxy/status', async (req, res) => {
  const { username } = req.query;
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  const activeClients = [];
  
  for (const [clientId, status] of clientStatusCache.entries()) {
    if (status.lastSeen > last24h) {
      activeClients.push({
        clientId,
        lastSeen: status.lastSeen.toISOString(),
        totalMessages: status.totalMessages,
        lastMessageCount: status.lastMessageCount,
        hoursAgo: Math.round((now - status.lastSeen) / (1000 * 60 * 60) * 10) / 10
      });
    }
  }
  
  // Sort by most recent
  activeClients.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  
  res.json({
    activeClients,
    totalActiveClients: activeClients.length,
    timeWindow: '24 hours',
    timestamp: now.toISOString()
  });
});

// Clean up old client status entries
setInterval(() => {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours
  let removed = 0;
  
  for (const [clientId, status] of clientStatusCache.entries()) {
    if (status.lastSeen < cutoff) {
      clientStatusCache.delete(clientId);
      removed++;
    }
  }
  
  if (removed > 0 && DEBUG) {
    console.log(`Cleaned up ${removed} old client status entries`);
  }
}, 3600000); // Every hour

// Enhanced v2 health endpoint
app.get('/ais-proxy/v2/health', async (req, res) => {
  try {
    const keys = await loadApiKeys();
    const enabledUserKeys = Object.values(keys.users || {}).filter(k => k.enabled).length;
    const hasAISStreamKey = !!(keys.aisstream?.primary?.key || keys.aisstream?.backup?.key);
    
    // Calculate vessel statistics
    let classA = 0, classB = 0, navigationAids = 0, other = 0;
    let oldestUpdate = new Date();
    let newestUpdate = new Date(0);
    
    for (const vessel of vesselCache.values()) {
      if (vessel._messageType === 'PositionReport') classA++;
      else if (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport') classB++;
      else if (vessel._messageType === 'AidsToNavigationReport') navigationAids++;
      else other++;
      
      if (vessel.lastUpdate < oldestUpdate) oldestUpdate = vessel.lastUpdate;
      if (vessel.lastUpdate > newestUpdate) newestUpdate = vessel.lastUpdate;
    }
    
    res.json({
      status: 'ok',
      apiVersion: '2.0',
      uptime: process.uptime(),
      vessels: {
        total: vesselCache.size,
        classA,
        classB,
        navigationAids,
        other
      },

      dataFreshness: {
        oldestUpdate: vesselCache.size > 0 ? oldestUpdate.toISOString() : null,
        newestUpdate: vesselCache.size > 0 ? newestUpdate.toISOString() : null
      },
      configuration: {
        userKeysConfigured: enabledUserKeys,
        aisstreamKeyConfigured: hasAISStreamKey,
        atApiKeyConfigured: !!(keys.aucklandTransport?.key),
        atFerryPolling: !!atFerryInterval,
        publicMode: !!keys._publicMode,
        configBucket: !!CONFIG_BUCKET,
        debugMode: DEBUG
      },
      websocket: {
        connected: wsConnection?.readyState === 1,
        reconnectAttempts
      },
      lookupQueue: {
        nameLookupQueue: nameLookupQueue.length,
        nameLookupInProgress
      },
      uploadClients: {
        totalClients: clientStatusCache.size,
        activeClients24h: Array.from(clientStatusCache.values())
          .filter(status => status.lastSeen > new Date(Date.now() - 24 * 60 * 60 * 1000)).length
      },
      vesselFinderApi: {
        circuitBreakerState,
        failureCount,
        lastFailureTime: lastFailureTime ? new Date(lastFailureTime).toISOString() : null
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  if (wsConnection) {
    wsConnection.close(1000, 'Server shutdown');
  }
  if (pingInterval) {
    clearInterval(pingInterval);
  }
  stopATFerryPolling();
  saveCache();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  if (wsConnection) {
    wsConnection.close(1000, 'Server shutdown');
  }
  if (pingInterval) {
    clearInterval(pingInterval);
  }
  stopATFerryPolling();
  saveCache();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`AIS Proxy server running on port ${PORT}`);
  loadCache();
  connectToAISStream();
  startATFerryPolling();
  

});