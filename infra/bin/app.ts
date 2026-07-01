#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { ReviewQueueStack } from '../lib/review-queue-stack'

const app = new cdk.App()

// OAuth App credentials. The client id is public; the secret must never be
// committed — pass both via `-c` context or environment variables at deploy.
const clientId = app.node.tryGetContext('clientId') ?? process.env.GITHUB_CLIENT_ID
const clientSecret = app.node.tryGetContext('clientSecret') ?? process.env.GITHUB_CLIENT_SECRET

new ReviewQueueStack(app, 'ReviewQueue', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  clientId,
  clientSecret,
})
