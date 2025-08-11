/**
 * CloudFront Construct - CDN for tileserver-gl
 */
import { Construct } from 'constructs';
import {
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_route53_targets as targets,
  Duration,
} from 'aws-cdk-lib';

/**
 * Properties for the CloudFront construct
 */
export interface CloudFrontProps {
  /**
   * ALB domain name to use as origin
   */
  albDomainName: string;

  /**
   * SSL certificate for CloudFront
   */
  certificate: acm.ICertificate;

  /**
   * Route53 hosted zone
   */
  hostedZone: route53.IHostedZone;

  /**
   * Hostname for the tiles service
   */
  hostname: string;
}

/**
 * CDK construct for CloudFront distribution for tiles
 */
export class CloudFront extends Construct {
  /**
   * CloudFront distribution
   */
  public readonly distribution: cloudfront.Distribution;

  /**
   * Domain name of the distribution
   */
  public readonly domainName: string;

  constructor(scope: Construct, id: string, props: CloudFrontProps) {
    super(scope, id);

    const { albDomainName, certificate, hostedZone, hostname } = props;

    // Create origin for ALB
    const albOrigin = new origins.HttpOrigin(albDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: {
        'Host': `${hostname}.${hostedZone.zoneName}`,
      },
    });

    // Create cache policies
    const tileCachePolicy = new cloudfront.CachePolicy(this, 'TileCachePolicy', {
      cachePolicyName: 'TileServerGL-Tiles',
      defaultTtl: Duration.days(30),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const metadataCachePolicy = new cloudfront.CachePolicy(this, 'MetadataCachePolicy', {
      cachePolicyName: 'TileServerGL-Metadata',
      defaultTtl: Duration.hours(1),
      maxTtl: Duration.days(1),
      minTtl: Duration.minutes(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const noCachePolicy = new cloudfront.CachePolicy(this, 'NoCachePolicy', {
      cachePolicyName: 'TileServerGL-NoCache',
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      minTtl: Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // Create distribution
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [`${hostname}.${hostedZone.zoneName}`],
      certificate,
      defaultBehavior: {
        origin: albOrigin,
        cachePolicy: metadataCachePolicy,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        // Tile endpoints - long cache
        '/styles/*/tiles/*': {
          origin: albOrigin,
          cachePolicy: tileCachePolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        // Rendered tiles - long cache
        '/styles/*/*.png': {
          origin: albOrigin,
          cachePolicy: tileCachePolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        // Health endpoint - no cache
        '/health': {
          origin: albOrigin,
          cachePolicy: noCachePolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
      },
    });

    this.domainName = this.distribution.distributionDomainName;

    // Create Route53 record pointing to CloudFront
    new route53.ARecord(this, 'ARecord', {
      zone: hostedZone,
      recordName: hostname,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      ),
    });

    new route53.AaaaRecord(this, 'AaaaRecord', {
      zone: hostedZone,
      recordName: hostname,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution)
      ),
    });
  }
}