#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { ReviewQueueStack } from '../lib/review-queue-stack'

// OAuth App credentials. The client id is public; the secret must never be
// committed — pass both as environment variables at deploy time.
const clientId = process.env.GITHUB_CLIENT_ID
const clientSecret = process.env.GITHUB_CLIENT_SECRET
if (!clientId || !clientSecret) {
  throw new Error(
    'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET before running cdk (see infra/README.md). ' +
      'Deploying without them would ship a Lambda whose every token exchange fails.',
  )
}

const app = new cdk.App()

new ReviewQueueStack(app, 'ReviewQueue', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  clientId,
  clientSecret,
})
