import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class JevDiscordStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    const config = props.config ?? {};

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0
    });

    const deadLetterQueue = new sqs.Queue(this, 'DiscordMessagesDlq', {
      fifo: true,
      retentionPeriod: Duration.days(14)
    });

    const queue = new sqs.Queue(this, 'DiscordMessages', {
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: Duration.minutes(3),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 5 }
    });

    const table = new dynamodb.Table(this, 'ConversationTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY
    });
    table.addGlobalSecondaryIndex({
      indexName: 'MessageIdIndex',
      partitionKey: { name: 'messageLookupId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const decisionTable = new dynamodb.Table(this, 'DecisionTable', {
      partitionKey: { name: 'sourceMessageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN
    });

    const credentialsSecret = new secretsmanager.Secret(this, 'Credentials', {
      secretName: 'jev-discord-gate-v1/credentials',
      description: 'Discord, TypeSafe, and OpenAI credentials for Jev Discord Gate V1',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          DISCORD_TOKEN: 'replace-me',
          TYPESAFE_API_KEY: 'replace-me',
          OPENAI_API_KEY: 'replace-me'
        }),
        generateStringKey: '_placeholder',
        excludePunctuation: true
      }
    });

    const processorLogs = new logs.LogGroup(this, 'ProcessorLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const processor = new lambdaNodejs.NodejsFunction(this, 'Processor', {
      entry: path.join(__dirname, '../src/processor/handler.js'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(90),
      reservedConcurrentExecutions: 5,
      logGroup: processorLogs,
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'node22',
        format: lambdaNodejs.OutputFormat.ESM,
        mainFields: ['module', 'main'],
        externalModules: []
      },
      environment: {
        TABLE_NAME: table.tableName,
        DECISION_TABLE_NAME: decisionTable.tableName,
        CREDENTIALS_SECRET_ARN: credentialsSecret.secretArn,
        SHADOW_MODE: config.shadowMode ?? 'true',
        OPENAI_MODEL: config.openAiModel ?? 'gpt-5.6-sol',
        JEV_MODEL: config.jevModel ?? 'jev-latest',
        HOT_CONTEXT_LIMIT: config.hotContextLimit ?? '30',
        GATE_THRESHOLD: config.gateThreshold ?? '0.58',
        CONTEXT_THRESHOLD: config.contextThreshold ?? '0.55',
        EXPLICIT_REQUEST_THRESHOLD: config.explicitRequestThreshold ?? '0.85',
        ORGANIC_MIN_VALUE: config.organicMinValue ?? '0.70',
        ORGANIC_MIN_NOVELTY: config.organicMinNovelty ?? '0.65',
        ORGANIC_MIN_NEED: config.organicMinNeed ?? '0.55',
        ORGANIC_MAX_INTRUSIVE: config.organicMaxIntrusive ?? '0.40',
        ORGANIC_MAX_RESOLVED: config.organicMaxResolved ?? '0.50',
        ORGANIC_COOLDOWN_SECONDS: config.organicCooldownSeconds ?? '180',
        AGENT_ROUTE_MIN_PROBABILITY: config.agentRouteMinProbability ?? '0.50',
        MESSAGE_TTL_DAYS: config.messageTtlDays ?? '30',
        DECISION_TTL_DAYS: config.decisionTtlDays ?? '90',
        OPENAI_MAX_OUTPUT_TOKENS: config.openAiMaxOutputTokens ?? '700',
        JEV_TIMEOUT_MS: config.jevTimeoutMs ?? '15000',
        OPENAI_TIMEOUT_MS: config.openAiTimeoutMs ?? '60000',
        DISCORD_TIMEOUT_MS: config.discordTimeoutMs ?? '10000'
      }
    });

    table.grantReadWriteData(processor);
    decisionTable.grantReadWriteData(processor);
    credentialsSecret.grantRead(processor);

    processor.addEventSource(new lambdaEventSources.SqsEventSource(queue, {
      batchSize: 1,
      reportBatchItemFailures: true
    }));

    const cluster = new ecs.Cluster(this, 'GatewayCluster', { vpc });

    const gatewayTask = new ecs.FargateTaskDefinition(this, 'GatewayTask', {
      cpu: 256,
      memoryLimitMiB: 512
    });

    queue.grantSendMessages(gatewayTask.taskRole);

    const gatewayLogs = new logs.LogGroup(this, 'GatewayLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const gatewayContainer = gatewayTask.addContainer('Gateway', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../src/gateway')),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'gateway',
        logGroup: gatewayLogs
      }),
      environment: {
        QUEUE_URL: queue.queueUrl,
        AWS_REGION_NAME: this.region,
        ALLOWED_GUILD_IDS: config.allowedGuildIds ?? '',
        ALLOWED_CHANNEL_IDS: config.allowedChannelIds ?? ''
      },
      secrets: {
        DISCORD_TOKEN: ecs.Secret.fromSecretsManager(credentialsSecret, 'DISCORD_TOKEN')
      },
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "process.exit(0)"'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(15)
      }
    });

    // No inbound ports are needed. The bot opens outbound connections to Discord and AWS.

    const gatewaySecurityGroup = new ec2.SecurityGroup(this, 'GatewaySecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Outbound-only security group for Discord Gateway task'
    });

    new ecs.FargateService(this, 'GatewayService', {
      cluster,
      taskDefinition: gatewayTask,
      desiredCount: Number(config.gatewayDesiredCount ?? '0'),
      assignPublicIp: true,
      securityGroups: [gatewaySecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      circuitBreaker: { rollback: true }
    });

    gatewayTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sqs:GetQueueAttributes'],
      resources: [queue.queueArn]
    }));

    new cdk.CfnOutput(this, 'CredentialsSecretName', {
      value: credentialsSecret.secretName
    });
    new cdk.CfnOutput(this, 'QueueUrl', {
      value: queue.queueUrl
    });
    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: deadLetterQueue.queueUrl
    });
    new cdk.CfnOutput(this, 'DeadLetterQueueArn', {
      value: deadLetterQueue.queueArn
    });
    new cdk.CfnOutput(this, 'ConversationTableName', {
      value: table.tableName
    });
    new cdk.CfnOutput(this, 'DecisionTableName', {
      value: decisionTable.tableName
    });
    new cdk.CfnOutput(this, 'ShadowMode', {
      value: config.shadowMode ?? 'true'
    });
  }
}
