import express from 'express';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const CONFIG_KEY = process.env.CONFIG_KEY || 'ETL-Util-AIS-Proxy-Api-Keys.json';
const DEBUG = process.env.DEBUG === 'true';
const CACHE_FILE = '/data/vessel-cache.json';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

// In-memory caches
const vesselCache = new Map();
const apiKeyCache = new Map();
const rateLimitCache = new Map();
const nameLookupQueue = [];
let nameLookupInProgress = false;

const RATE_LIMIT_PER_MINUTE = 600;
const NAME_LOOKUP_DELAY = 2000; // 2 seconds between lookups

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
    console.error('Failed to load API keys from S3:', error.message);
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
    }
  } catch (error) {
    console.warn('Failed to load cache:', error.message);
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
    console.warn('Failed to save cache:', error.message);
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
    FilterMessageTypes: ["PositionReport", "ShipStaticData", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "AidsToNavigationReport"]
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
      console.warn('Failed to parse AIS message:', error);
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
    console.error('WebSocket error:', error.message || error);
    scheduleReconnect();
  });

  wsConnection.on('close', (code, reason) => {
    console.log(`WebSocket connection closed (code: ${code}, reason: ${reason || 'unknown'})`);
    
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

// Enhanced vessel lookup
async function lookupVesselData(mmsi) {
  try {
    const response = await fetch(`https://www.vesselfinder.com/api/pub/click/${mmsi}`, {
      timeout: 5000,
      headers: { 'User-Agent': 'AIS-Proxy/1.0' }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (!data.name) return null;
    
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
        console.warn(`Unknown vessel type from VesselFinder: "${data.type}" (${typeKey})`);
      }
    }
    
    return {
      name: data.name.trim(),
      type: aisType,
      imo: data.imo || null,
      country: data.country || null,
      grossTonnage: data.gt || null,
      deadweight: data.dw || null,
      yearBuilt: data.y || null,
      typeText: data.type || null
    };
  } catch (error) {
    if (DEBUG) console.warn(`Vessel lookup failed for MMSI ${mmsi}:`, error.message);
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
    
    if (!vessel) continue; // Skip if vessel gone
    
    // Skip if vessel already has both name and type, or if we only need name but already have it
    const needsName = !vessel.NAME && (vessel._messageType === 'StandardClassBPositionReport' || vessel._messageType === 'ExtendedClassBPositionReport');
    const needsType = vessel.TYPE === null && vessel._messageType !== 'AidsToNavigationReport';
    
    if (!needsName && !needsType) continue;
    
    if (DEBUG) console.log(`Looking up MMSI ${mmsi}: needs name=${needsName}, needs type=${needsType}`);
    
    const vesselData = await lookupVesselData(mmsi);
    if (vesselData) {
      // Update name if missing
      if (!vessel.NAME && vesselData.name) {
        vessel.NAME = vesselData.name;
        vessel._nameSource = 'lookup';
      }
      
      // Update type if missing
      if (vessel.TYPE === null && vesselData.type !== null) {
        vessel.TYPE = vesselData.type;
      }
      if (!vessel.IMO && vesselData.imo) vessel.IMO = vesselData.imo;
      
      // Store additional lookup data
      vessel._lookupCountry = vesselData.country;
      vessel._lookupGrossTonnage = vesselData.grossTonnage;
      vessel._lookupDeadweight = vesselData.deadweight;
      vessel._lookupYearBuilt = vesselData.yearBuilt;
      vessel._lookupTypeText = vesselData.typeText;
      
      if (DEBUG) console.log(`Enhanced data for MMSI ${mmsi}: ${vesselData.name} (${vesselData.typeText}) - AIS type: ${vesselData.type}`);
    } else {
      if (DEBUG) console.log(`No data found for MMSI ${mmsi}`);
    }
    
    vessel._nameLastLookup = new Date();
    
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
    // Process queue in next tick to avoid blocking
    setImmediate(processNameLookupQueue);
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
    vessel.TIME = message.MetaData.time_utc;
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
      const oneDayAgo = new Date(Date.now() - 86400000);
      if (!vessel._nameLastLookup || vessel._nameLastLookup < oneDayAgo) {
        if (DEBUG) console.log(`Queueing lookup for MMSI ${mmsi}: NAME=${vessel.NAME}, TYPE=${vessel.TYPE}, messageType=${vessel._messageType}`);
        queueNameLookup(mmsi);
      } else {
        if (DEBUG) console.log(`Skipping lookup for MMSI ${mmsi}: last lookup was ${vessel._nameLastLookup}`);
      }
    } else {
      if (DEBUG && (vessel.MMSI === 512009284 || vessel.MMSI === 512009382)) {
        console.log(`Not queueing lookup for MMSI ${mmsi}: NAME=${vessel.NAME}, TYPE=${vessel.TYPE}, messageType=${vessel._messageType}`);
      }
    }
    
    // Save cache occasionally
    if (Math.random() < 0.01) saveCache();
    
  } catch (error) {
    console.warn('Error processing AIS message:', error.message);
    if (DEBUG) console.warn('Message:', message);
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
    return res.json({ ERROR: true });
  }
  
  // Check rate limit
  const rateLimitCheck = checkRateLimit(username, keyValidation.rateLimit);
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

// Enhanced v2 API endpoint
app.get('/ais-proxy/v2/vessels', async (req, res) => {
  const { username, latmin, latmax, lonmin, lonmax, include } = req.query;
  
  // Validate user API key
  const keyValidation = await validateUserApiKey(username);
  if (!keyValidation.valid) {
    return res.status(401).json({ error: 'Unauthorized', message: keyValidation.reason });
  }
  
  // Check rate limit
  const rateLimitCheck = checkRateLimit(username, keyValidation.rateLimit);
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
      public_mode: !!keys._publicMode,
      config_bucket: !!CONFIG_BUCKET
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Health check failed'
    });
  }
});

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
        publicMode: !!keys._publicMode,
        configBucket: !!CONFIG_BUCKET,
        debugMode: DEBUG
      },
      websocket: {
        connected: wsConnection?.readyState === 1,
        reconnectAttempts
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
  saveCache();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`AIS Proxy server running on port ${PORT}`);
  loadCache();
  connectToAISStream();
});