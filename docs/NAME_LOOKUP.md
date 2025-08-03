# Vessel Name Lookup

The AIS Proxy service includes automatic vessel name lookup for Class B vessels that don't broadcast their names in AIS messages.

## How It Works

1. **Class A vessels** broadcast names in `ShipStaticData` messages but may lack type info
2. **Class B vessels** often only send position data without names or types
3. **Automatic lookup** queries external APIs for vessels missing name OR type data
4. **Enhanced enrichment** includes name, type, country, tonnage, and build year
5. **Type mapping** converts text descriptions to AIS type codes
6. **Rate limited** to avoid overwhelming external services
7. **Cached** to prevent repeated lookups (24-hour cache)

## Implementation Details

### Lookup Process
- **Triggered when**: Class B vessel has no name OR any vessel has no type
- **Covers**: Both Class A and Class B vessels with missing data
- Uses VesselFinder free API endpoint
- Queued and processed with 2-second delays
- Only attempts lookup once per day per vessel
- Gracefully handles failures

### Data Sources
- **Primary**: VesselFinder API (`https://www.vesselfinder.com/api/pub/click/{mmsi}`)
- **Fallback**: Could add additional sources in future

### Vessel Type Mapping

Text descriptions from VesselFinder are mapped to AIS type codes:

| VesselFinder Type | AIS Code | Description |
|-------------------|----------|-------------|
| Cargo ship | 70 | General cargo |
| Container ship | 70 | Container vessel |
| Tanker | 80 | Liquid bulk |
| Passenger ship | 60 | Passenger vessel |
| Fishing vessel | 30 | Fishing |
| Tug/Tugboat | 52 | Tug |
| Yacht | 37 | Pleasure craft |
| Sailing vessel | 36 | Sailing |
| Military/Naval | 35 | Military ops |

**Benefits:**
- Class B vessels get proper AIS type codes
- Consistent with AIS standards
- Better vessel classification

### Rate Limiting
- 2-second delay between lookup requests
- Maximum 1 lookup per vessel per 24 hours
- Non-blocking queue processing
- Fails gracefully if service unavailable

## API Response

The `nameSource` field indicates where the vessel name came from:

```json
{
  "mmsi": 123456789,
  "name": "VESSEL NAME",
  "nameSource": "lookup",  // "ais", "lookup", or null
  "category": "vessel"
}
```

**Values:**
- `"ais"` - Name from AIS static data message
- `"lookup"` - Name from external API lookup
- `null` - No name available from any source

## Performance Impact

- **Minimal** - Lookups happen asynchronously
- **Non-blocking** - Doesn't delay AIS message processing
- **Cached** - Prevents repeated API calls
- **Rate limited** - Respects external service limits

## Configuration

Currently uses VesselFinder's free tier:
- No API key required
- Reasonable rate limits
- Good coverage for commercial vessels
- May have limited data for small recreational craft

## Monitoring

Name lookup statistics are included in logs:
- Successful lookups logged in debug mode
- Failed lookups logged as warnings
- Queue processing is non-blocking

## Future Enhancements

Potential improvements:
- Multiple lookup sources with fallback
- Configurable lookup providers
- Enhanced caching with persistence
- Lookup statistics in health endpoint