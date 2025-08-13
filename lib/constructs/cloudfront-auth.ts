/**
 * CloudFront API Key Authentication
 */
import { Construct } from 'constructs';
import {
  aws_cloudfront as cloudfront,
} from 'aws-cdk-lib';

export interface CloudFrontAuthProps {
  validApiKeys: string[];
}

export class CloudFrontAuth extends Construct {
  public readonly function: cloudfront.Function;

  constructor(scope: Construct, id: string, props: CloudFrontAuthProps) {
    super(scope, id);

    const { validApiKeys } = props;

    // Create CloudFront function for API key validation
    this.function = new cloudfront.Function(this, 'ApiKeyFunction', {
      functionName: `tileserver-api-auth-${Date.now()}`,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
    var request = event.request;
    var querystring = request.querystring;
    
    // Allow health check without API key
    if (request.uri === '/health') {
        return request;
    }
    
    // Check for API key
    if (!querystring.api || !querystring.api.value) {
        return {
            statusCode: 401,
            statusDescription: 'Unauthorized',
            body: 'API key required'
        };
    }
    
    var providedKey = querystring.api.value;
    var validKeys = ${JSON.stringify(validApiKeys)};
    
    if (validKeys.indexOf(providedKey) === -1) {
        return {
            statusCode: 403,
            statusDescription: 'Forbidden', 
            body: 'Invalid API key'
        };
    }
    
    return request;
}
      `),
    });
  }
}