import * as path from 'node:path'
import {
  Stack,
  StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_lambda as lambda,
  aws_s3_deployment as s3deploy,
} from 'aws-cdk-lib'
import { Construct } from 'constructs'

export interface ReviewQueueStackProps extends StackProps {
  /** OAuth App client id (public). */
  clientId: string
  /** OAuth App client secret — set at deploy, never committed. */
  clientSecret: string
}

/**
 * Static app on S3 + CloudFront, with a token-exchange Lambda routed at
 * `/auth/*` on the same CloudFront origin. Same-origin routing means the
 * browser never makes a cross-origin request, so there is no CORS to manage
 * and the frontend needs no backend URL baked in at build time.
 */
export class ReviewQueueStack extends Stack {
  constructor(scope: Construct, id: string, props: ReviewQueueStackProps) {
    super(scope, id, props)

    // Private bucket — reachable only through CloudFront via Origin Access Control.
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })

    // Token-exchange Lambda — the only place the client secret lives.
    const exchangeFn = new lambda.Function(this, 'OAuthExchange', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'oauth-exchange')),
      timeout: Duration.seconds(10),
      memorySize: 128,
      environment: {
        GITHUB_CLIENT_ID: props.clientId,
        GITHUB_CLIENT_SECRET: props.clientSecret,
      },
    })

    const fnUrl = exchangeFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
    })

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        // OAuth token exchange — never cache, forward the POST body, drop the
        // Host header (Function URLs reject a mismatched Host).
        '/auth/*': {
          origin: new origins.FunctionUrlOrigin(fnUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      // Single-page app: serve index.html for unknown paths.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    })

    // Upload the built app. Requires `npm run build` in the repo root first.
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'dist'))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    })

    new CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'App URL and OAuth callback origin (register this on the OAuth App).',
    })
    new CfnOutput(this, 'FunctionUrl', {
      value: fnUrl.url,
      description: 'Raw Lambda Function URL (normally reached via /auth/* on the site).',
    })
  }
}
