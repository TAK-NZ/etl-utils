# LINZ Vector Tiles Auto-Update

## Overview

Automated monthly workflow to download, convert, and upload LINZ topographic vector tiles to S3 buckets for both demo and production environments.

## Schedule

- **Frequency**: Monthly on the 1st at 2 AM UTC
- **Manual Trigger**: Available via workflow_dispatch

## Prerequisites

### GitHub Secrets Required

Add `LINZ_API_KEY` to both demo and production environments:

1. Go to repository Settings → Secrets and variables → Actions
2. Under each environment (demo/production), add:
   - **Name**: `LINZ_API_KEY`
   - **Value**: Your LINZ Data Service API key from https://basemaps.linz.govt.nz/

### Existing Secrets Used

The workflow automatically uses existing secrets:
- `DEMO_AWS_ROLE_ARN` / `PROD_AWS_ROLE_ARN`
- `DEMO_AWS_REGION` / `PROD_AWS_REGION`
- `DEMO_STACK_NAME` / `PROD_STACK_NAME` (from vars)

## What It Does

1. **Downloads** LINZ topographic tiles (3857.mbtiles format)
2. **Converts** to pmtiles format using go-pmtiles
3. **Uploads** to S3:
   - `linz-vector-tiles.pmtiles` → CloudTAK assets bucket (`public/` prefix)
   - `linz-vector-tiles.mbtiles` → BaseInfra artifacts bucket

## Production Safety

- Production job only runs if:
  - `vars.PROD_DEPLOYED == 'true'` (GitHub org/repo variable)
  - `tileserver-gl.enabled = true` in `cdk.json`
- Runs after successful demo update
- Uses the same enabled check pattern as build/deploy workflows

### Setting PROD_DEPLOYED Variable

1. Go to repository Settings → Secrets and variables → Actions → Variables tab
2. Add variable:
   - **Name**: `PROD_DEPLOYED`
   - **Value**: `true` (when production is deployed) or `false` (to skip)
3. This can be set at organization or repository level

## S3 Bucket Discovery

Buckets are automatically discovered from CloudFormation stack outputs:
- **Assets Bucket**: `TAK-{STACK_NAME}-CloudTAK` → `AssetsBucketNameOutput`
- **Artifacts Bucket**: `TAK-{STACK_NAME}-BaseInfra` → `ArtifactsBucketNameOutput`

## Manual Execution

```bash
# Via GitHub UI
Actions → Update LINZ Vector Tiles → Run workflow

# Via GitHub CLI
gh workflow run update-linz-tiles.yml
```

## Monitoring

Check workflow runs at: `.github/workflows/update-linz-tiles.yml` in Actions tab

## File Sizes

- **mbtiles**: ~2-3 GB (full New Zealand topographic data)
- **pmtiles**: Similar size, optimized for cloud-native access
- **Download time**: ~10-15 minutes depending on LINZ service speed
