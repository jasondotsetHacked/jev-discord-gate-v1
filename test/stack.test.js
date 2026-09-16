import test from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { JevDiscordStack } from '../lib/jev-discord-stack.js';

const app = new cdk.App();
const template = Template.fromStack(new JevDiscordStack(app, 'TestStack', { config: {} }));

test('stack includes FIFO source queue and FIFO dead-letter queue', () => {
  template.resourceCountIs('AWS::SQS::Queue', 2);
  template.hasResourceProperties('AWS::SQS::Queue', { FifoQueue: true, RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }) });
});

test('stack includes conversation and retained decision DynamoDB tables', () => {
  template.resourceCountIs('AWS::DynamoDB::Table', 2);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: Match.arrayWith([{ AttributeName: 'sourceMessageId', KeyType: 'HASH' }]),
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true }
  });
});

test('Lambda event source is FIFO-safe and processor can read its secret', () => {
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 1, FunctionResponseTypes: ['ReportBatchItemFailures'] });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
      Action: Match.arrayWith(['secretsmanager:GetSecretValue']), Effect: 'Allow'
    })]) }
  });
});

test('Fargate remains stopped by default with a public IP and no inbound listener', () => {
  template.hasResourceProperties('AWS::ECS::Service', {
    DesiredCount: 0, NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }) }
  });
  assert.ok(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'));
  assert.equal(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')).length, 0);
});
