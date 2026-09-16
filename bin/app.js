#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { JevDiscordStack } from '../lib/jev-discord-stack.js';

const app = new cdk.App();

const asString = (name, fallback) => {
  const value = app.node.tryGetContext(name);
  return value === undefined || value === null || value === '' ? fallback : String(value);
};

new JevDiscordStack(app, 'JevDiscordGateV1', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  },
  config: {
    shadowMode: asString('shadowMode', 'true'),
    openAiModel: asString('openAiModel', 'gpt-5.6-sol'),
    jevModel: asString('jevModel', 'jev-latest'),
    hotContextLimit: asString('hotContextLimit', '30'),
    gateThreshold: asString('gateThreshold', '0.58'),
    contextThreshold: asString('contextThreshold', '0.55'),
    messageTtlDays: asString('messageTtlDays', '30'),
    gatewayDesiredCount: asString('gatewayDesiredCount', '0'),
    allowedGuildIds: asString('allowedGuildIds', ''),
    allowedChannelIds: asString('allowedChannelIds', '')
  }
});
