# API Version Differences

This document outlines the key differences between v1 and v2 APIs.

## Data Filtering

### V1 API (`/ais-proxy/ws.php`)
- **Vessels Only**: Shows moving vessels (Class A and Class B)
- **Navigation Aids**: Automatically filtered out for AISHub compatibility
- **Purpose**: Drop-in replacement for AISHub API

### V2 API (`/ais-proxy/v2/vessels`)
- **Configurable**: Use `include` parameter to control what's returned
- **Default**: Shows vessels only (`include=vessels`)
- **Optional**: Can include navigation aids (`include=navigation-aids` or `include=all`)
- **Purpose**: Enhanced API with full feature set

## Examples

### V1 API - Always Vessels Only
```bash
GET /ais-proxy/ws.php?username=key
# Returns: Vessels only (Class A + Class B)
# Navigation aids: Filtered out automatically
```

### V2 API - Configurable
```bash
# Vessels only (default, same as v1)
GET /ais-proxy/v2/vessels?username=key&include=vessels

# Navigation aids only
GET /ais-proxy/v2/vessels?username=key&include=navigation-aids

# Everything
GET /ais-proxy/v2/vessels?username=key&include=all
```

## Why This Design?

1. **V1 Compatibility**: Existing AISHub clients expect vessels only
2. **V2 Flexibility**: New clients can choose what data they need
3. **Performance**: Clients can avoid unnecessary data
4. **Clear Separation**: Different APIs for different use cases

## Migration Path

- **Stay on V1**: If you only need vessels and want AISHub compatibility
- **Move to V2**: If you want navigation aids, enhanced fields, or better error handling
- **Use Both**: V1 for legacy systems, V2 for new features