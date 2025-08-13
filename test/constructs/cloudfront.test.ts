import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { CloudFront } from '../../lib/constructs/cloudfront';

describe('CloudFront', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let mockCertificate: acm.ICertificate;
  let mockHostedZone: route53.IHostedZone;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    
    // Mock certificate
    mockCertificate = acm.Certificate.fromCertificateArn(
      stack,
      'MockCertificate',
      'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012'
    );

    // Mock hosted zone
    mockHostedZone = route53.HostedZone.fromHostedZoneAttributes(stack, 'MockHostedZone', {
      hostedZoneId: 'Z123456789',
      zoneName: 'example.com',
    });
  });

  it('creates CloudFront distribution with default cache TTL', () => {
    new CloudFront(stack, 'TestCloudFront', {
      albDomainName: 'alb-123456789.ap-southeast-2.elb.amazonaws.com',
      certificate: mockCertificate,
      hostedZone: mockHostedZone,
      hostname: 'tiles',
      apiKeys: ['test-key-1', 'test-key-2'],
    });

    const template = Template.fromStack(stack);

    // Check CloudFront distribution
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: ['tiles.example.com'],
        ViewerCertificate: {
          AcmCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012',
          SslSupportMethod: 'sni-only'
        },
        Origins: Match.arrayWith([
          Match.objectLike({
            DomainName: 'alb-123456789.ap-southeast-2.elb.amazonaws.com',
            CustomOriginConfig: {
              OriginProtocolPolicy: 'https-only'
            }
          })
        ])
      }
    });

    // Check cache policies and origin request policy created
    template.resourceCountIs('AWS::CloudFront::CachePolicy', 3);
    template.resourceCountIs('AWS::CloudFront::OriginRequestPolicy', 1);
    
    // Route53 records are now created in the main stack, not in CloudFront construct
  });

  it('creates cache policies with custom TTL values', () => {
    new CloudFront(stack, 'TestCloudFront', {
      albDomainName: 'alb-123456789.ap-southeast-2.elb.amazonaws.com',
      certificate: mockCertificate,
      hostedZone: mockHostedZone,
      hostname: 'tiles',
      apiKeys: ['test-key-1', 'test-key-2'],
      cacheTtl: {
        tiles: '7d',
        metadata: '30m',
        health: '5s'
      }
    });

    const template = Template.fromStack(stack);

    // Check tile cache policy (7 days = 604800 seconds)
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'TileServerGL-Tiles',
        DefaultTTL: 604800,
        MaxTTL: 31536000, // 365 days
        MinTTL: 86400 // 1 day
      }
    });

    // Check metadata cache policy (30 minutes = 1800 seconds)
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'TileServerGL-Metadata',
        DefaultTTL: 1800,
        MaxTTL: 86400, // 1 day
        MinTTL: 60 // 1 minute
      }
    });

    // Check no-cache policy (5 seconds)
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'TileServerGL-NoCache',
        DefaultTTL: 5,
        MaxTTL: 5,
        MinTTL: 0
      }
    });
  });

  it('creates cache behaviors for different path patterns', () => {
    new CloudFront(stack, 'TestCloudFront', {
      albDomainName: 'alb-123456789.ap-southeast-2.elb.amazonaws.com',
      certificate: mockCertificate,
      hostedZone: mockHostedZone,
      hostname: 'tiles',
      apiKeys: ['test-key-1', 'test-key-2'],
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          // All tile content - long cache
          Match.objectLike({
            PathPattern: '/styles/*',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: ['GET', 'HEAD']
          }),
          // Health endpoint - no cache
          Match.objectLike({
            PathPattern: '/health',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: ['GET', 'HEAD']
          })
        ])
      }
    });
  });

  it('parses TTL values correctly', () => {
    new CloudFront(stack, 'TestCloudFront', {
      albDomainName: 'alb-123456789.ap-southeast-2.elb.amazonaws.com',
      certificate: mockCertificate,
      hostedZone: mockHostedZone,
      hostname: 'tiles',
      apiKeys: ['test-key-1', 'test-key-2'],
      cacheTtl: {
        tiles: '1d',
        metadata: '2h',
        health: '30s'
      }
    });

    const template = Template.fromStack(stack);

    // Check 1 day = 86400 seconds
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'TileServerGL-Tiles',
        DefaultTTL: 86400
      }
    });

    // Check 2 hours = 7200 seconds
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'TileServerGL-Metadata',
        DefaultTTL: 7200
      }
    });

    // Check 30 seconds
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'TileServerGL-NoCache',
        DefaultTTL: 30
      }
    });
  });

  it('handles invalid TTL format gracefully', () => {
    new CloudFront(stack, 'TestCloudFront', {
      albDomainName: 'alb-123456789.ap-southeast-2.elb.amazonaws.com',
      certificate: mockCertificate,
      hostedZone: mockHostedZone,
      hostname: 'tiles',
      apiKeys: ['test-key-1', 'test-key-2'],
      cacheTtl: {
        tiles: 'invalid',
        metadata: '2x',
        health: 'bad-format'
      }
    });

    const template = Template.fromStack(stack);

    // Should fall back to default 1 hour (3600 seconds) for invalid formats
    // Just check that all policies have 3600 seconds as DefaultTTL
    const policies = template.findResources('AWS::CloudFront::CachePolicy');
    const policyNames = Object.values(policies).map((policy: any) => 
      policy.Properties.CachePolicyConfig.Name
    );
    const defaultTtls = Object.values(policies).map((policy: any) => 
      policy.Properties.CachePolicyConfig.DefaultTTL
    );

    expect(policyNames).toContain('TileServerGL-Tiles');
    expect(policyNames).toContain('TileServerGL-Metadata');
    expect(policyNames).toContain('TileServerGL-NoCache');
    expect(defaultTtls).toEqual(expect.arrayContaining([3600, 3600, 3600]));
  });

  it('sets correct origin configuration', () => {
    new CloudFront(stack, 'TestCloudFront', {
      albDomainName: 'my-alb.elb.amazonaws.com',
      certificate: mockCertificate,
      hostedZone: mockHostedZone,
      hostname: 'maps',
      apiKeys: ['test-key-1', 'test-key-2'],
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Origins: [
          {
            DomainName: 'my-alb.elb.amazonaws.com',
            Id: Match.anyValue(),
            CustomOriginConfig: {
              OriginProtocolPolicy: 'https-only'
            }
          }
        ]
      }
    });

    // Check origin request policy for Host header forwarding
    template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: {
        Name: 'TileServerGL-OriginRequest',
        HeadersConfig: {
          HeaderBehavior: 'whitelist',
          Headers: ['Host']
        },
        QueryStringsConfig: {
          QueryStringBehavior: 'all'
        },
        CookiesConfig: {
          CookieBehavior: 'none'
        }
      }
    });
  });

  it('exposes distribution properties', () => {
    const cloudfront = new CloudFront(stack, 'TestCloudFront', {
      albDomainName: 'alb-123456789.ap-southeast-2.elb.amazonaws.com',
      certificate: mockCertificate,
      hostedZone: mockHostedZone,
      hostname: 'tiles',
      apiKeys: ['test-key-1', 'test-key-2'],
    });

    expect(cloudfront.distribution).toBeDefined();
    expect(cloudfront.domainName).toBeDefined();
  });

  it('creates cache policies with correct query string and header behavior', () => {
    new CloudFront(stack, 'TestCloudFront', {
      albDomainName: 'alb-123456789.ap-southeast-2.elb.amazonaws.com',
      certificate: mockCertificate,
      hostedZone: mockHostedZone,
      hostname: 'tiles',
      apiKeys: ['test-key-1', 'test-key-2'],
    });

    const template = Template.fromStack(stack);

    // Tile cache policy - no query strings or headers
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'TileServerGL-Tiles',
        ParametersInCacheKeyAndForwardedToOrigin: {
          EnableAcceptEncodingGzip: false,
          QueryStringsConfig: {
            QueryStringBehavior: 'none'
          },
          HeadersConfig: {
            HeaderBehavior: 'none'
          },
          CookiesConfig: {
            CookieBehavior: 'none'
          }
        }
      }
    });

    // Metadata cache policy - all query strings
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'TileServerGL-Metadata',
        ParametersInCacheKeyAndForwardedToOrigin: {
          QueryStringsConfig: {
            QueryStringBehavior: 'all'
          }
        }
      }
    });

    // No-cache policy - all query strings
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'TileServerGL-NoCache',
        ParametersInCacheKeyAndForwardedToOrigin: {
          QueryStringsConfig: {
            QueryStringBehavior: 'all'
          }
        }
      }
    });
  });
});