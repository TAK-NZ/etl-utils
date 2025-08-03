#!/usr/bin/env node

// Script to find missing vessel types from VesselFinder
const API_KEY = process.env.AIS_API_KEY;
const API_URL = `https://utils.test.tak.nz/ais-proxy/ws.php?username=${API_KEY}`;
const DELAY_MS = 2000; // 2 second delay between VesselFinder requests

if (!API_KEY) {
  console.error('Error: AIS_API_KEY environment variable is required');
  process.exit(1);
}

async function fetchAISData() {
  console.log('Fetching AIS data...');
  const response = await fetch(API_URL);
  const data = await response.json();
  return data.VESSELS || [];
}

async function lookupVesselType(mmsi) {
  try {
    const response = await fetch(`https://www.vesselfinder.com/api/pub/click/${mmsi}`, {
      headers: { 'User-Agent': 'AIS-Type-Finder/1.0' }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    return data.type || null;
  } catch (error) {
    console.warn(`Lookup failed for MMSI ${mmsi}:`, error.message);
    return null;
  }
}

async function main() {
  try {
    // Get vessels with null type
    const vessels = await fetchAISData();
    const nullTypeVessels = vessels.filter(v => v.TYPE === null);
    
    console.log(`Found ${vessels.length} total vessels`);
    console.log(`Found ${nullTypeVessels.length} vessels with TYPE=null`);
    
    if (nullTypeVessels.length === 0) {
      console.log('No vessels with null type found.');
      return;
    }
    
    // Lookup types from VesselFinder
    const typeCount = new Map();
    let processed = 0;
    
    for (const vessel of nullTypeVessels) {
      console.log(`Processing ${++processed}/${nullTypeVessels.length}: MMSI ${vessel.MMSI}`);
      
      const type = await lookupVesselType(vessel.MMSI);
      if (type) {
        const count = typeCount.get(type) || 0;
        typeCount.set(type, count + 1);
        console.log(`  Found type: "${type}"`);
      } else {
        console.log(`  No type found`);
      }
      
      // Rate limit
      if (processed < nullTypeVessels.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      }
    }
    
    // Print results
    console.log('\n=== MISSING VESSEL TYPES ===');
    if (typeCount.size === 0) {
      console.log('No vessel types found from VesselFinder');
    } else {
      const sortedTypes = Array.from(typeCount.entries())
        .sort((a, b) => b[1] - a[1]); // Sort by count descending
      
      console.log(`Found ${typeCount.size} unique vessel types:`);
      console.log('');
      
      for (const [type, count] of sortedTypes) {
        console.log(`"${type}": ${count} vessel${count > 1 ? 's' : ''}`);
      }
      
      console.log('\n=== SUGGESTED MAPPINGS ===');
      for (const [type] of sortedTypes) {
        const key = type.toLowerCase();
        console.log(`  '${key}': ??, // ${type}`);
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();