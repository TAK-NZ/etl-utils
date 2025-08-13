/**
 * Lambda@Edge function in us-east-1 for CloudFront
 */
import { Construct } from 'constructs';
import {
  aws_lambda as lambda,
  aws_iam as iam,
  Duration,
  Stack,
} from 'aws-cdk-lib';

export interface EdgeAuthUsEast1Props {
  configBucket: string;
  configKey: string;
}

export class EdgeAuthUsEast1 extends Construct {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: EdgeAuthUsEast1Props) {
    super(scope, id);

    const { configBucket, configKey } = props;

    // Create Lambda function in us-east-1 for Lambda@Edge
    this.function = new lambda.Function(this, 'Function', {
      functionName: `tileserver-styles-auth-${Date.now()}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: Duration.seconds(5),
      memorySize: 128,
      code: lambda.Code.fromInline(`
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({ region: 'us-west-2' });
let cachedKeys = null;
let cacheExpiry = 0;

exports.handler = async (event) => {
    const request = event.Records[0].cf.request;
    
    // Only validate /styles/* paths - allow everything else
    if (!request.uri.startsWith('/styles/')) {
        return request;
    }
    
    // Check for API key in query string
    const querystring = request.querystring || '';
    const apiKeyMatch = querystring.match(/(?:^|&)api=([^&]*)/);
    
    if (!apiKeyMatch) {
        return {
            status: '401',
            statusDescription: 'Unauthorized',
            body: 'API key required for styles access'
        };
    }
    
    const providedKey = decodeURIComponent(apiKeyMatch[1]);
    
    try {
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
            cacheExpiry = now + 300000;
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