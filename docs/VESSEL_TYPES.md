# Vessel Type Mapping

This document lists the vessel type mappings from VesselFinder text descriptions to AIS type codes.

## Current Mappings

| VesselFinder Type | AIS Code | AIS Description |
|-------------------|----------|-----------------|
| Cargo ship | 70 | Cargo, all ships of this type |
| Cargo | 70 | Cargo, all ships of this type |
| Container ship | 70 | Cargo, all ships of this type |
| Bulk carrier | 70 | Cargo, all ships of this type |
| General cargo | 70 | Cargo, all ships of this type |
| Tanker | 80 | Tanker, all ships of this type |
| Oil tanker | 80 | Tanker, all ships of this type |
| Chemical tanker | 80 | Tanker, all ships of this type |
| Gas tanker | 80 | Tanker, all ships of this type |
| Passenger ship | 60 | Passenger, all ships of this type |
| Passenger | 60 | Passenger, all ships of this type |
| Cruise ship | 60 | Passenger, all ships of this type |
| Ferry | 60 | Passenger, all ships of this type |
| Ro-ro passenger | 60 | Passenger, all ships of this type |
| Fishing vessel | 30 | Fishing |
| Fishing | 30 | Fishing |
| Fishing support vessel | 30 | Fishing |
| Tug | 52 | Tug |
| Tugboat | 52 | Tug |
| Pilot vessel | 50 | Pilot Vessel |
| Pilot | 50 | Pilot Vessel |
| Pleasure craft | 37 | Pleasure Craft |
| Yacht | 37 | Pleasure Craft |
| Sailing vessel | 36 | Sailing |
| Sailing | 36 | Sailing |
| Military | 35 | Military ops |
| Naval | 35 | Military ops |
| Warship | 35 | Military ops |
| Research vessel | 58 | Medical transports |
| Research | 58 | Medical transports |
| Supply vessel | 79 | Cargo, no additional info |
| Offshore supply | 79 | Cargo, no additional info |
| Platform supply | 79 | Cargo, no additional info |
| Anchor handling | 79 | Cargo, no additional info |
| Dredger | 33 | Dredging or underwater ops |
| Diving vessel | 33 | Dredging or underwater ops |
| Law enforcement | 55 | Law Enforcement |
| Patrol vessel | 55 | Law Enforcement |
| Rescue vessel | 51 | Search and Rescue vessel |
| Search and rescue | 51 | Search and Rescue vessel |
| Icebreaker | 52 | Tug |
| Cable layer | 57 | Spare - Local Vessel |
| Pipe layer | 57 | Spare - Local Vessel |
| Bulk Carrier | 70 | Cargo, all ships of this type |
| Container Ship | 70 | Cargo, all ships of this type |
| Towing vessel | 52 | Tug |
| HSC | 40 | High speed craft |
| WIG | 20 | Wing in ground |
| Dredging or UW ops | 33 | Dredging or underwater ops |
| SAR | 51 | Search and Rescue vessel |
| Other type | 0 | Not available |
| Unknown | 0 | Not available |

## AIS Type Code Reference

| Code | Description |
|------|-------------|
| 0 | Not available |
| 20 | Wing in ground |
| 30 | Fishing |
| 33 | Dredging or underwater ops |
| 35 | Military ops |
| 36 | Sailing |
| 37 | Pleasure Craft |
| 40 | High speed craft |
| 50 | Pilot Vessel |
| 51 | Search and Rescue vessel |
| 52 | Tug |
| 55 | Law Enforcement |
| 57 | Spare - Local Vessel |
| 58 | Medical transports |
| 60 | Passenger, all ships of this type |
| 70 | Cargo, all ships of this type |
| 79 | Cargo, no additional info |
| 80 | Tanker, all ships of this type |

## Unknown Types

The system automatically logs unknown vessel types from VesselFinder that aren't in our mapping. Check the application logs for warnings like:

```
Unknown vessel type from VesselFinder: "New Type" (new type)
```

## Adding New Types

To add new vessel type mappings:

1. **Identify the VesselFinder type** from logs or API responses
2. **Choose appropriate AIS code** from the reference above
3. **Add to VESSEL_TYPE_MAPPING** in `server.js`
4. **Update this documentation**

## Notes

- **Case insensitive**: All comparisons are done in lowercase
- **Fallback**: Unknown types return `null` for AIS code but preserve original text
- **Logging**: Unknown types are logged once per application restart
- **Coverage**: Mapping covers most common vessel types but VesselFinder may introduce new ones

## Data Sources

- **AIS Type Codes**: Based on ITU-R M.1371-5 standard
- **VesselFinder Types**: Observed from API responses (undocumented)
- **Mapping Logic**: Best-effort matching to appropriate AIS categories