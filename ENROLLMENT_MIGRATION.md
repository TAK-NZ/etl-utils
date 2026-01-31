# Enrollment Migration Plan: Auth-Infra → Utils-Infra

## Overview

This document outlines the migration of device enrollment functionality from the `auth-infra` repository to the `etl-utils` repository (to be renamed `utils-infra`). The migration leverages the existing ALB infrastructure in utils-infra to reduce costs and improve architectural consistency.

## Migration Benefits

- **Cost Savings**: ~$20-25/month per environment by reusing existing ALB
- **Architectural Consistency**: Enrollment becomes a utility service alongside other utilities
- **Infrastructure Reuse**: Leverages existing ALB, Route53, and security group configurations
- **Dependency Management**: Utils-infra can import from both AuthInfra and TAK-Infra

## Phase 1: File Migration

### Files to Move from `auth-infra` to `etl-utils`

#### CDK Constructs
```bash
# Source: auth-infra/lib/constructs/
# Destination: etl-utils/lib/constructs/

enrollment-lambda.ts           → enrollment-lambda.ts
enroll-oidc-setup.ts          → enroll-oidc-setup.ts
enroll-alb-oidc-auth.ts       → enroll-alb-oidc-auth.ts
enroll-alb-oidc.ts            → enroll-alb-oidc.ts (may be simplified)
route53-enrollment.ts         → route53-enrollment.ts (may be removed - ALB handles this)
```

#### Lambda Source Code
```bash
# Source: auth-infra/src/
# Destination: etl-utils/

enrollment-lambda/            → enrollment-lambda/
├── views/                    → views/
│   ├── partials/            → partials/
│   ├── content.ejs          → content.ejs
│   ├── error.ejs            → error.ejs
│   └── loader.ejs           → loader.ejs
├── index.js                 → index.js
├── package.json             → package.json
└── package-lock.json        → package-lock.json

enroll-oidc-setup/           → enroll-oidc-setup/
├── index.js                 → index.js
├── package.json             → package.json
├── package-lock.json        → package-lock.json
├── TAK-Enroll.png          → TAK-Enroll.png
└── README.md               → README.md

enroll-alb-oidc-auth/        → enroll-alb-oidc-auth/
├── index.js                 → index.js
├── package.json             → package.json
└── package-lock.json        → package-lock.json
```

#### Documentation
```bash
# Source: auth-infra/docs/
# Destination: etl-utils/docs/

ENROLLMENT_GUIDE.md          → ENROLLMENT_GUIDE.md (update paths and references)
```

## Phase 2: Node.js Build Process

### Critical Build Requirements

The `src/` directories contain Node.js Lambda functions that require proper dependency management during CDK builds. This has been a recurring issue in this repository.

#### Current Build Problems
- CDK NodejsFunction bundling fails when `node_modules` are missing
- Lambda functions have their own `package.json` with specific dependencies
- Build process doesn't automatically install dependencies in subdirectories

#### Solution: Pre-Build Script

Create a pre-build script to install dependencies:

```bash
# etl-utils/scripts/install-lambda-deps.sh
#!/bin/bash
set -e

echo "Installing Lambda function dependencies..."

# Install enrollment-lambda dependencies
if [ -d "enrollment-lambda" ]; then
    echo "Installing enrollment-lambda dependencies..."
    cd enrollment-lambda
    npm ci --production
    cd ..
fi

# Install enroll-oidc-setup dependencies  
if [ -d "enroll-oidc-setup" ]; then
    echo "Installing enroll-oidc-setup dependencies..."
    cd enroll-oidc-setup
    npm ci --production
    cd ..
fi

# Install enroll-alb-oidc-auth dependencies
if [ -d "enroll-alb-oidc-auth" ]; then
    echo "Installing enroll-alb-oidc-auth dependencies..."
    cd enroll-alb-oidc-auth
    npm ci --production
    cd ..
fi

echo "Lambda dependencies installed successfully"
```

#### Update package.json Scripts

```json
{
  "scripts": {
    "prebuild": "chmod +x scripts/install-lambda-deps.sh && scripts/install-lambda-deps.sh",
    "build": "tsc",
    "predeploy": "npm run prebuild && npm run build",
    "deploy": "cdk deploy",
    "deploy:dev": "cdk deploy --context envType=dev-test",
    "deploy:prod": "cdk deploy --context envType=prod"
  }
}
```

#### CDK NodejsFunction Configuration

Update the NodejsFunction bundling configuration to handle the pre-installed dependencies:

```typescript
// In enrollment-lambda construct
const enrollmentLambda = new nodejs.NodejsFunction(this, 'EnrollmentFunction', {
  entry: path.join(__dirname, '../../enrollment-lambda/index.js'),
  bundling: {
    commandHooks: {
      beforeBundling(inputDir: string, outputDir: string): string[] {
        return [
          // Ensure dependencies are installed
          `cd ${inputDir}/enrollment-lambda && npm ci --production`
        ];
      },
      afterBundling(inputDir: string, outputDir: string): string[] {
        return [
          // Copy views directory
          `cp -r ${inputDir}/enrollment-lambda/views ${outputDir}/`
        ];
      },
      beforeInstall(): string[] { return []; }
    },
    nodeModules: ['qrcode', 'ejs'], // Explicitly include required modules
    externalModules: ['@aws-sdk/*'] // AWS SDK v3 available in runtime
  }
});
```

## Phase 3: Configuration Updates

### Update etl-utils cdk.json

Add enrollment configuration to the containers section:

```json
{
  "context": {
    "dev-test": {
      "containers": {
        "enrollment": {
          "enabled": true,
          "hostname": "device",
          "port": 3000,
          "priority": 50,
          "cpu": 256,
          "memory": 512,
          "healthCheckPath": "/health",
          "requiresAuth": true,
          "authType": "oidc"
        }
      },
      "enrollment": {
        "enrollmentEnabled": true,
        "providerName": "TAK-Device-Activation",
        "applicationName": "TAK Device Enrollment",
        "applicationSlug": "tak-device-activation",
        "enrollmentHostname": "device",
        "groupName": "Team Awareness Kit",
        "description": "Enrol a mobile device with ATAK/iTAK/TAK Aware"
      }
    }
  }
}
```

### Update Stack Configuration

Add enrollment-specific imports and configuration:

```typescript
// etl-utils/lib/stack-config.ts
export interface ContextEnvironmentConfig {
  // ... existing config
  enrollment?: {
    enrollmentEnabled: boolean;
    providerName: string;
    applicationName: string;
    applicationSlug: string;
    enrollmentHostname: string;
    groupName: string;
    description: string;
  };
}
```

## Phase 4: Infrastructure Integration

### Update ALB Construct

Modify the ALB construct to support OIDC authentication:

```typescript
// etl-utils/lib/constructs/alb.ts
public addOidcRule(
  id: string,
  hostname: string,
  targetGroup: elbv2.ApplicationTargetGroup,
  oidcConfig: {
    clientId: string;
    clientSecret: string;
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userInfoEndpoint: string;
  },
  priority: number
): elbv2.ApplicationListenerRule {
  return new elbv2.ApplicationListenerRule(this, `${id}OidcRule`, {
    listener: this.httpsListener,
    priority,
    conditions: [
      elbv2.ListenerCondition.hostHeaders([`${hostname}.${this.hostedZone.zoneName}`])
    ],
    action: elbv2.ListenerAction.authenticateOidc({
      authorizationEndpoint: oidcConfig.authorizationEndpoint,
      clientId: oidcConfig.clientId,
      clientSecret: oidcConfig.clientSecret,
      issuer: oidcConfig.issuer,
      tokenEndpoint: oidcConfig.tokenEndpoint,
      userInfoEndpoint: oidcConfig.userInfoEndpoint,
      next: elbv2.ListenerAction.forward([targetGroup])
    })
  });
}
```

### Update Main Stack

Integrate enrollment into the main stack:

```typescript
// etl-utils/lib/etl-utils-stack.ts
import { EnrollmentLambda } from './constructs/enrollment-lambda';
import { EnrollOidcSetup } from './constructs/enroll-oidc-setup';

// In the main stack constructor, add enrollment service
if (envConfig.enrollment?.enrollmentEnabled) {
  // Import OIDC configuration from AuthInfra
  const oidcClientId = Fn.importValue(`TAK-${stackNameComponent}-AuthInfra-OidcClientId`);
  const oidcClientSecret = Fn.importValue(`TAK-${stackNameComponent}-AuthInfra-OidcClientSecret`);
  const oidcIssuer = Fn.importValue(`TAK-${stackNameComponent}-AuthInfra-OidcIssuer`);
  
  // Create enrollment Lambda
  const enrollmentLambda = new EnrollmentLambda(this, 'EnrollmentLambda', {
    // ... configuration
  });
  
  // Add to ALB with OIDC authentication
  alb.addOidcRule(
    'enrollment',
    envConfig.enrollment.enrollmentHostname,
    enrollmentLambda.targetGroup,
    {
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
      issuer: oidcIssuer,
      // ... other OIDC endpoints
    },
    50
  );
}
```

## Phase 5: CloudFormation Imports

### Required Imports from AuthInfra

```typescript
// etl-utils/lib/cloudformation-imports.ts
export const AUTH_EXPORT_NAMES = {
  OIDC_CLIENT_ID: 'OidcClientId',
  OIDC_CLIENT_SECRET: 'OidcClientSecret', 
  OIDC_ISSUER: 'OidcIssuer',
  OIDC_AUTHORIZE_URL: 'OidcAuthorizeUrl',
  OIDC_TOKEN_URL: 'OidcTokenUrl',
  OIDC_USER_INFO_URL: 'OidcUserInfoUrl',
  AUTHENTIK_ADMIN_TOKEN: 'AuthentikAdminTokenArn'
} as const;

export function createAuthImportValue(stackName: string, exportName: string): string {
  return `TAK-${stackName}-AuthInfra-${exportName}`;
}
```

### Required Imports from TAK-Infra

```typescript
export const TAK_EXPORT_NAMES = {
  TAK_SERVER_DOMAIN: 'TakServerDomain',
  TAK_SERVER_PORT: 'TakServerPort'
} as const;

export function createTakImportValue(stackName: string, exportName: string): string {
  return `TAK-${stackName}-TakInfra-${exportName}`;
}
```

## Phase 6: Testing Strategy

### Pre-Migration Testing
1. **Backup Current State**: Document current enrollment functionality
2. **Test Current ALB**: Verify existing utils services work correctly
3. **Dependency Verification**: Ensure all required exports exist

### Migration Testing
1. **Build Verification**: 
   ```bash
   npm run prebuild  # Install Lambda dependencies
   npm run build     # Compile TypeScript
   npm run synth     # Generate CloudFormation
   ```

2. **Deployment Testing**:
   ```bash
   # Deploy to dev-test first
   npm run deploy:dev
   
   # Verify enrollment functionality
   curl -I https://device.dev.tak.nz
   ```

3. **Integration Testing**:
   - Test OIDC authentication flow
   - Verify QR code generation
   - Test device enrollment process
   - Validate ALB routing

### Post-Migration Testing
1. **Functional Testing**: Complete enrollment workflow
2. **Performance Testing**: Lambda cold start times
3. **Security Testing**: OIDC authentication flow
4. **Cost Verification**: Confirm ALB cost savings

## Phase 7: Cleanup

### Remove from auth-infra
After successful migration and testing:

1. **Remove Enrollment Resources**:
   - Delete enrollment constructs from auth-infra stack
   - Remove enrollment ALB and target groups
   - Clean up Route53 records
   - Remove enrollment Lambda functions

2. **Update auth-infra Exports**:
   - Keep OIDC configuration exports for utils-infra
   - Remove enrollment-specific exports
   - Update documentation

3. **Update Dependencies**:
   - Remove enrollment-related dependencies from package.json
   - Clean up unused imports

## Rollback Plan

If migration fails:

1. **Immediate Rollback**: Redeploy auth-infra with enrollment enabled
2. **Partial Rollback**: Keep OIDC setup in utils-infra, move Lambda back to auth-infra
3. **Full Rollback**: Revert all changes and restore original architecture

## Timeline

- **Phase 1-2**: File migration and build setup (1-2 days)
- **Phase 3-4**: Configuration and infrastructure updates (2-3 days)  
- **Phase 5**: CloudFormation imports setup (1 day)
- **Phase 6**: Testing and validation (2-3 days)
- **Phase 7**: Cleanup and documentation (1 day)

**Total Estimated Time**: 7-10 days

## Success Criteria

- [ ] Enrollment functionality works identically to current implementation
- [ ] ALB cost savings achieved (~$20-25/month per environment)
- [ ] All tests pass
- [ ] Documentation updated
- [ ] No service disruption during migration
- [ ] Rollback plan tested and verified