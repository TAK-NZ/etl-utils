/**
 * Lambda@Edge API Key Authentication
 */
import { Construct } from 'constructs';
import {
  aws_lambda as lambda,
  aws_iam as iam,
  Duration,
} from 'aws-cdk-lib';

export interface EdgeAuthProps {
  configBucket: string;
  configKey: string;
}

export class EdgeAuth extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: EdgeAuthProps) {
    super(scope, id);

    const { configBucket, configKey } = props;

    this.function = new lambda.Function(this, 'EdgeAuthFunction', {
      functionName: `tileserver-edge-auth-${Date.now()}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: Duration.seconds(5),
      memorySize: 128,
      code: lambda.Code.fromInline(`
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({ region: 'us-east-1' });
let cachedKeys = null;
let cacheExpiry = 0;

exports.handler = async (event) => {
    const request = event.Records[0].cf.request;
    
    // Allow health check without API key
    if (request.uri === '/health') {
        return request;
    }
    
    // Check for API key in query string
    const querystring = request.querystring || '';
    const apiKeyMatch = querystring.match(/(?:^|&)api=([^&]*)/);
    
    if (!apiKeyMatch) {
        return {
            status: '401',
            statusDescription: 'Unauthorized',
            body: 'API key required'
        };
    }
    
    const providedKey = decodeURIComponent(apiKeyMatch[1]);
    
    try {
        // Get valid keys from S3 (with caching)
        const now = Date.now();
        if (!cachedKeys || now > cacheExpiry) {
            const command = new GetObjectCommand({
                Bucket: '${configBucket}',
                Key: '${configKey}'
            });
            
            const response = await s3.send(command);
            const configText = await response.Body.transformToString();
            const config = JSON.parse(configText);
            
            cachedKeys = new Set(config.apiKeys || []);
            cacheExpiry = now + 300000; // Cache for 5 minutes
        }
        
        if (!cachedKeys.has(providedKey)) {
            return {
                status: '403',
                statusDescription: 'Forbidden',
                body: 'Invalid API key'
            };
        }
        
        return request;
        
    } catch (error) {
        console.error('Auth error:', error);
        return {
            status: '500',
            statusDescription: 'Internal Server Error',
            body: 'Authentication service error'
        };
    }
};
      `),
    });

    // Grant S3 permissions
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${configBucket}/${configKey}`],
      })
    );
  }
}