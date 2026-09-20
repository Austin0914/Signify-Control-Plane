import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
  aws_cognito as cognito, aws_dynamodb as dynamodb, aws_lambda as lambda,
  aws_lambda_event_sources as eventSources, aws_logs as logs, aws_s3 as s3,
  aws_secretsmanager as secretsmanager, aws_cloudwatch as cloudwatch,
} from "aws-cdk-lib";
import {
  CorsHttpMethod, HttpApi, HttpMethod, WebSocketApi, WebSocketStage,
} from "aws-cdk-lib/aws-apigatewayv2";
import {
  HttpJwtAuthorizer, HttpLambdaAuthorizer, HttpLambdaResponseType, WebSocketLambdaAuthorizer,
} from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
// This module executes from infra/dist/lib after `tsc`; walk back to the repository root.
const serviceEntry = (file: string) => path.join(dirname, "../../../services/control-plane/src", file);

interface ControlPlaneStackProps extends StackProps {
  environmentName: string;
  frontendOrigin: string;
}

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);
    const suffix = props.environmentName;
    const removalPolicy = suffix === "demo" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const configTable = new dynamodb.Table(this, "ConfigTable", {
      tableName: `signify-control-${suffix}-config`, partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sortKey", type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt", pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy,
    });
    const liveTable = new dynamodb.Table(this, "LiveTable", {
      tableName: `signify-control-${suffix}-live`, partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sortKey", type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAtEpoch", stream: dynamodb.StreamViewType.NEW_IMAGE, pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy,
    });
    const identityTable = new dynamodb.Table(this, "IdentityTable", {
      tableName: `signify-control-${suffix}-identity`, partitionKey: { name: "tokenHash", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, timeToLiveAttribute: "expiresAt", pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy,
    });
    const exportsBucket = new s3.Bucket(this, "ExportsBucket", {
      bucketName: `signify-control-${suffix}-exports-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: Duration.days(7), abortIncompleteMultipartUploadAfter: Duration.days(1) }], removalPolicy,
      autoDeleteObjects: suffix === "dev",
    });
    const deviceTokenSecret = new secretsmanager.Secret(this, "DeviceTokenPepper", {
      secretName: `signify-control/${suffix}/device-token-pepper`, generateSecretString: { passwordLength: 48, excludePunctuation: true }, removalPolicy,
    });

    const userPool = new cognito.UserPool(this, "Operators", {
      userPoolName: `signify-control-${suffix}-operators`, selfSignUpEnabled: false,
      signInAliases: { email: true }, autoVerify: { email: true },
      passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY, removalPolicy,
    });
    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: `signify-control-${suffix}-web`, generateSecret: false,
      authFlows: { userSrp: true }, preventUserExistenceErrors: true, disableOAuth: true,
    });

    const commonEnvironment = {
      CONFIG_TABLE: configTable.tableName, LIVE_TABLE: liveTable.tableName, IDENTITY_TABLE: identityTable.tableName,
      EXPORTS_BUCKET: exportsBucket.bucketName, DEVICE_TOKEN_SECRET_ARN: deviceTokenSecret.secretArn,
      HEARTBEAT_STALE_SECONDS: "45",
    };
    const makeFunction = (id: string, entry: string, handler: string, extra: Record<string, string> = {}) => {
      const fn = new NodejsFunction(this, id, {
        functionName: `signify-control-${suffix}-${id.toLowerCase()}`, runtime: lambda.Runtime.NODEJS_22_X,
        entry: serviceEntry(entry), handler, timeout: Duration.seconds(10), memorySize: 256,
        logGroup: new logs.LogGroup(this, `${id}Logs`, { logGroupName: `/aws/lambda/signify-control-${suffix}-${id.toLowerCase()}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy }),
        environment: { ...commonEnvironment, ...extra }, bundling: { minify: true, sourceMap: true },
      });
      return fn;
    };

    const operatorFn = makeFunction("OperatorApi", "operator-api.ts", "handler");
    const deviceFn = makeFunction("DeviceApi", "device-api.ts", "handler");
    const deviceAuthorizerFn = makeFunction("DeviceAuthorizer", "device-api.ts", "authorizer");
    const wsAuthorizerFn = makeFunction("WsAuthorizer", "device-api.ts", "websocketAuthorizer");
    const wsConnectFn = makeFunction("WsConnect", "websocket.ts", "connect");
    const wsDisconnectFn = makeFunction("WsDisconnect", "websocket.ts", "disconnect");
    const wsMessageFn = makeFunction("WsMessage", "websocket.ts", "message");

    configTable.grantReadWriteData(operatorFn); liveTable.grantReadWriteData(operatorFn); identityTable.grantReadWriteData(operatorFn);
    deviceTokenSecret.grantRead(operatorFn); exportsBucket.grantReadWrite(operatorFn);
    configTable.grantReadData(deviceFn); liveTable.grantReadWriteData(deviceFn); identityTable.grantReadWriteData(deviceFn); deviceTokenSecret.grantRead(deviceFn);
    identityTable.grantReadData(deviceAuthorizerFn); deviceTokenSecret.grantRead(deviceAuthorizerFn);
    identityTable.grantReadData(wsAuthorizerFn); deviceTokenSecret.grantRead(wsAuthorizerFn);
    liveTable.grantReadWriteData(wsConnectFn); liveTable.grantReadWriteData(wsDisconnectFn);
    liveTable.grantReadWriteData(wsMessageFn); configTable.grantReadData(wsMessageFn);

    const operatorAuthorizer = new HttpJwtAuthorizer("OperatorJwt", userPool.userPoolProviderUrl, {
      jwtAudience: [userPoolClient.userPoolClientId],
    });
    const deviceAuthorizer = new HttpLambdaAuthorizer("DeviceBearer", deviceAuthorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE], identitySource: ["$request.header.Authorization"], resultsCacheTtl: Duration.seconds(0),
    });
    const httpApi = new HttpApi(this, "HttpApi", {
      apiName: `signify-control-${suffix}-http`, corsPreflight: {
        allowOrigins: [props.frontendOrigin], allowHeaders: ["authorization", "content-type", "if-match", "idempotency-key"],
        exposeHeaders: ["etag"], allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT, CorsHttpMethod.OPTIONS], maxAge: Duration.hours(1),
      },
    });
    // Keep OPTIONS out of the authenticated proxy route so API Gateway's CORS
    // responder can complete browser preflights before Cognito authorization.
    httpApi.addRoutes({
      path: "/api/v1/{proxy+}",
      methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PUT],
      integration: new HttpLambdaIntegration("OperatorIntegration", operatorFn),
      authorizer: operatorAuthorizer,
    });
    httpApi.addRoutes({ path: "/device/v1/pairing/redeem", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("PairingIntegration", deviceFn) });
    httpApi.addRoutes({ path: "/device/v1/config/latest", methods: [HttpMethod.GET], integration: new HttpLambdaIntegration("DeviceConfigIntegration", deviceFn), authorizer: deviceAuthorizer });

    const wsAuthorizer = new WebSocketLambdaAuthorizer("DeviceWsBearer", wsAuthorizerFn, { identitySource: ["route.request.header.Authorization"] });
    const wsApi = new WebSocketApi(this, "WebSocketApi", {
      apiName: `signify-control-${suffix}-ws`, routeSelectionExpression: "$request.body.messageType",
      connectRouteOptions: { integration: new WebSocketLambdaIntegration("ConnectIntegration", wsConnectFn), authorizer: wsAuthorizer },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration("DisconnectIntegration", wsDisconnectFn) },
      defaultRouteOptions: { integration: new WebSocketLambdaIntegration("MessageIntegration", wsMessageFn) },
    });
    const wsStage = new WebSocketStage(this, "WebSocketStage", { webSocketApi: wsApi, stageName: suffix, autoDeploy: true });
    wsApi.grantManageConnections(wsConnectFn); wsApi.grantManageConnections(wsMessageFn);

    const deliveryFn = makeFunction("CommandDelivery", "websocket.ts", "delivery", { WS_MANAGEMENT_ENDPOINT: wsStage.callbackUrl });
    liveTable.grantReadWriteData(deliveryFn);
    wsApi.grantManageConnections(deliveryFn);
    deliveryFn.addEventSource(new eventSources.DynamoEventSource(liveTable, {
      startingPosition: lambda.StartingPosition.LATEST, batchSize: 10, bisectBatchOnError: true, retryAttempts: 3,
      filters: [lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual("INSERT"), dynamodb: { NewImage: { entityType: { S: lambda.FilterRule.isEqual("command") } } } })],
    }));

    for (const [name, fn] of [["Operator", operatorFn], ["Device", deviceFn], ["WebSocket", wsMessageFn], ["Delivery", deliveryFn]] as const) {
      new cloudwatch.Alarm(this, `${name}Errors`, { metric: fn.metricErrors({ period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1, alarmDescription: `${name} Lambda errors in ${suffix}` });
    }

    new CfnOutput(this, "HttpApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "WebSocketUrl", { value: wsStage.url });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, "ExportsBucketName", { value: exportsBucket.bucketName });
  }
}
