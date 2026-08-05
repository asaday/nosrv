# Deployment Design

nosrv generates portable application entrypoints and platform configuration. Public-cloud targets delegate authentication, infrastructure changes, uploads, and deployment state to each platform's official CLI. The self-hosted nosrv Platform accepts Artifacts directly and maintains its own application and version state.

## Delegation boundary

| Target             | nosrv owns                                                                            | Official CLI owns                                                                     | Status               |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------- |
| Cloudflare Workers | Worker entrypoint, Wrangler config, asset and capability bindings                     | Authentication, build/upload, resource resolution, deployment                         | Implemented          |
| nosrv Platform     | Deterministic Artifact, authenticated upload, digest verification, version activation | Self-hosted routing and process supervision                                           | Implemented MVP      |
| Google Functions   | Staging bundle, HTTP entrypoint, packaged assets, command arguments                   | Authentication, project selection, build/upload, function create/update               | Implemented for HTTP |
| AWS Lambda         | Staging bundle, handler, assets, SAM template                                         | Authentication, artifact build/upload, CloudFormation, IAM and resource create/update | Implemented for HTTP |
| Azure Functions    | Node.js v4 staging bundle, HTTP and Timer registration, packaged assets               | Authentication, Function App provisioning, build/upload, environment, deployment      | Implemented          |

For public-cloud targets, nosrv must not reimplement cloud authentication or maintain a competing deployment state database.

## Authentication prerequisites

Authenticate the provider-owned CLI before publishing:

```bash
# Install target support in the application first.
npm install -D @nosrv/cloudflare
# Or: npm install -D @nosrv/google-cloud
# Or: npm install -D @nosrv/aws
# Or: npm install -D @nosrv/azure
# Add this when Google Functions, AWS Lambda, or Azure Functions use PostgreSQL.
# npm install -D @nosrv/postgres

# Cloudflare: Wrangler is installed via @nosrv/cloudflare.
npx wrangler login
npx wrangler whoami
# For CI, set CLOUDFLARE_API_TOKEN instead.

# Google Cloud deployment identity and target project.
gcloud auth login
gcloud config set project PROJECT_ID
gcloud auth list
gcloud config get-value project

# AWS credentials used by SAM and CloudFormation.
aws configure
# Or: aws configure sso && aws sso login
aws sts get-caller-identity
sam --version

# Azure deployment identity, subscription, and Functions Core Tools.
az login
az account set --subscription SUBSCRIPTION
az account show
func --version
```

Google Application Default Credentials are separate from the account used by the `gcloud` CLI. Run `gcloud auth application-default login` only when local provider code needs to call GCS or Firestore through Google client libraries.

For automation, use each provider's supported non-interactive credential mechanism. Never store credentials in `nosrv.yaml`, generated deployment source, or the repository.

## Capability resource prerequisites

An HTTP-only App can normally proceed after CLI authentication, project/account selection, and region configuration. Cloud capabilities are references to provider-owned resources; they are not a request for nosrv to create infrastructure.

The self-hosted Platform chooses capability providers globally. Its development defaults give each
App SQLite database and KV files plus filesystem storage. Horizontally scaled installations use
PostgreSQL, Redis, and S3 or GCS storage instead.

| Target           | Before deploying capability-backed code                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare       | Create/select the Workers KV namespace, R2 bucket, or D1 database; place the required name or ID in `providers.cloudflare`; configure Wrangler secrets separately.                                                   |
| Google Functions | Create/select the Firestore database and GCS bucket, or a reachable PostgreSQL database; grant the required roles/network access; configure runtime environment values or Secret Manager mappings separately.        |
| AWS Lambda       | Create/select the DynamoDB table and S3 bucket, or a reachable PostgreSQL database; add least-privilege permissions/network access; configure runtime environment values or Secrets Manager integration separately.  |
| Azure Functions  | Create/select the Function App, host storage, Blob container, Cosmos DB database/container, or reachable PostgreSQL database; configure managed identity/RBAC, networking, and App settings or Key Vault references. |

Current deployment generation:

- configures adapter bindings from `nosrv.yaml`;
- packages application code and static assets;
- packages configured private `resources` for read-only access through `ctx.resources` without publishing them as static assets;
- delegates function/Worker deployment to the official CLI.

It does not currently:

- create or delete KV namespaces, buckets, databases, or tables;
- run database migrations;
- generate complete IAM policies for application data access;
- configure backups, retention, lifecycle rules, encryption policy, billing, or cross-region behavior;
- provision Google Cloud Scheduler or AWS EventBridge schedules. Azure Timer registrations are generated from `schedules`.

Keep secrets out of `nosrv.yaml`; store only non-secret resource identifiers there. Resource creation and permissions should be reviewed explicitly because they can incur cost and outlive an application deployment.

## Cloudflare Workers

Current command:

```bash
nosrv deploy --target cloudflare
```

Install `@nosrv/cloudflare` in the App so nosrv can resolve Wrangler and the Cloudflare adapter from the application root:

```bash
npm install -D @nosrv/cloudflare
```

Authenticate interactively with `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN` for a non-interactive environment.

Flow:

1. Read `nosrv.yaml` and resolve the application and providers.
2. Generate `.nosrv/cloudflare/worker.ts`.
3. Generate `.nosrv/cloudflare/wrangler.jsonc` with assets and bindings.
4. Invoke `wrangler deploy --config <generated-config>`.
5. Return Wrangler's output and exit status unchanged.

Additional Wrangler deploy arguments pass through:

```bash
nosrv deploy --target cloudflare --dry-run
nosrv deploy --target cloudflare --temporary
nosrv deploy --target cloudflare --env production
```

## nosrv Platform

Deploy starts the browser-based Platform login automatically when no saved personal token is found:

```bash
nosrv deploy --url https://nosrv.internal.example
```

When a Platform is behind Cloudflare Zero Trust or another authentication proxy, authenticate first
and save repeatable headers with `--header` or `-H`:

```bash
nosrv login --url https://nosrv.internal.example \
  -H 'cf-access-token: $ACCESS_TOKEN'
nosrv deploy
```

A value that consists entirely of `$NAME` or `${NAME}` is read from that environment variable and
fails when the variable is unset or empty. Quote the argument so the shell does not expand it first.
Use `$$NAME` when the literal value must begin with `$`. `Authorization`, `Host`, and
`Content-Length` cannot be overridden. Login saves the header definitions, not resolved environment
values. Later deployment, logout, and management requests resolve and reuse them automatically;
CLI-required headers take precedence.

`nosrv login` saves one current Platform with its URL, personal token, expiry, and header definitions.
Later `nosrv deploy`, `nosrv whoami`, and management commands need neither the same `--url` nor headers.
Run `nosrv login --url ...` again to switch the current Platform. CI can instead provide
`NOSRV_PLATFORM_URL`, `NOSRV_TOKEN`, and `-H` explicitly without a saved login.

Platform is the default deployment target. The CLI prints the selected target, destination, App name, digest, resulting version, and route. Use `--target` explicitly for public-cloud targets or when a script benefits from making the choice visible in its source.

With the default Docker Compose development setup, `nosrv deploy` defaults to
`http://127.0.0.1:3100` and authenticates as the configured local administrator. The optional
The [`compose.oidc.yaml`](https://github.com/asaday/nosrv-platform/blob/main/compose.oidc.yaml) stack permits any authenticated OIDC user to deploy while the App manager policy is
empty. Adding an `app_manager` policy rule restricts deployment to an authenticated `admin` or
`app_manager`; admin and viewer policy rules do not enable this restriction.

Declare the common App identity and optional Platform route in `nosrv.yaml`:

```yaml
name: my-app
app: ./src/app.ts
route: /my-app
```

The route is preserved in the Artifact. The Platform normalizes and validates it and rejects the
root, reserved control-plane paths, or a route already used by another App. If `route` is omitted,
a new App receives `/apps/<APP_NAME>` and a later deployment keeps the existing App route.
The destination URL and credentials are environment-specific and are not stored in `nosrv.yaml`.

Flow:

1. Resolve `nosrv.yaml`, bundle the application, and copy the fixed `public/` and `resources/` directories into a temporary deterministic Artifact.
2. Create a transport-only `tar.gz` archive.
3. Upload it with Bearer authentication from a personal login token or `NOSRV_TOKEN`.
4. Verify archive paths, entry types, upload size, manifest schema, and SHA-256 digest.
5. Copy the Artifact into Platform-owned storage and create or reuse its version.
6. Activate the version and restart its App Instance.
7. Remove client and server temporary files.

The Artifact contains a resolved `nosrv.yaml` as its single runtime configuration. Its internal
manifest contains only the Artifact schema version and integrity digest; it does not duplicate App
settings. The resolved configuration points `app` to the bundled entrypoint and omits source-only
development and deployment settings.

The destination URL is resolved from `--url`, `NOSRV_PLATFORM_URL`, or the destination saved by the last successful `nosrv login`, in that order, then defaults to `http://127.0.0.1:3100`. An optional token is resolved from `--token`, `NOSRV_TOKEN`, or a saved `nosrv login` credential. If none exists, an interactive deploy starts the same browser authorization as `nosrv login`, saves the resulting personal token and destination, and continues deployment. If a saved personal token is rejected, deploy clears it, signs in again, and retries the Artifact upload once. Explicit `--token` and `NOSRV_TOKEN` values are never replaced automatically. Prefer the environment variable for an issued CI personal token because command-line arguments may be retained in shell history or exposed through process inspection. The transport archive is not the stored Artifact format.

App runtime secrets are managed separately after deployment. Configure `secrets.masterKeyFile` on the Platform, then use its authenticated dashboard or per-App secrets API. Secret values are encrypted in Platform state and are not part of the Artifact or `nosrv.yaml`.

Apps declaring host `permissions` can deploy only to nosrv Platform. Filesystem read/write lists keep Node's Permission Model enabled with only those additional paths. `permissions.childProcess: true` additionally enables child process execution; Node does not restrict it to named commands. `permissions: "*"` requests unrestricted host access and requires `allowUnrestrictedApps: true` in the Platform configuration; public-cloud deployment targets reject both forms.

Handler-free static sites and file collections use the same flow. A root `index.html` is detected
without configuration. Otherwise, arbitrary public files belong in the fixed `public/` directory;
no public path setting is needed.

## Google Functions

Current command:

```bash
nosrv deploy --target google-functions
```

The Google Cloud CLI must be installed, authenticated with `gcloud auth login`, and pointed at the intended project. The project may instead be supplied through normal `gcloud` configuration or flags.

Install the target package in the App before deployment:

```bash
npm install -D @nosrv/google-cloud
# Add when providers.google-functions.db uses PostgreSQL.
# npm install -D @nosrv/postgres
```

Generated files:

```text
.nosrv/google-functions/deploy/
├── index.js
├── package.json
└── public/              # when configured
```

Current flow:

1. Validate deployment name, Google project context, region, and supported runtime.
2. Bundle the portable app and Google Functions adapter into a self-contained staging directory.
3. Copy built public assets when configured.
4. Generate an HTTP function entrypoint named `nosrv`.
5. Invoke `gcloud functions deploy` with `--gen2`, `--runtime`, `--region`, `--source`, `--entry-point=nosrv`, and `--trigger-http`.
6. Pass through supported gcloud deployment options and return its exit status.

Proposed configuration:

```yaml
deploy:
  google-functions:
    name: my-app
    region: asia-northeast1
    runtime: nodejs24
    allowUnauthenticated: false
```

Public access must be explicit; nosrv should not silently add `--allow-unauthenticated`.

Google scheduled-handler adaptation exists, but Cloud Scheduler job creation is not automated. A deployment containing `schedules` fails with an actionable message instead of silently deploying incomplete scheduling.

## AWS Lambda

Current command:

```bash
nosrv deploy --target lambda
```

The AWS CLI must have usable credentials and the AWS SAM CLI must be installed. Verify the effective identity with `aws sts get-caller-identity`; IAM Identity Center profiles should be refreshed with `aws sso login` before deployment.

Install the target package in the App before deployment:

```bash
npm install -D @nosrv/aws
# Add when providers.lambda.db uses PostgreSQL.
# npm install -D @nosrv/postgres
```

Generated files:

```text
.nosrv/lambda/deploy/
├── handler.mjs
├── public/              # when configured
└── template.yaml
```

Current flow:

1. Validate function name, region, runtime, and HTTP exposure configuration.
2. Bundle the portable app and Lambda adapter into the staging directory.
3. Copy built public assets when configured.
4. Generate an AWS SAM template for the Lambda function and selected HTTP endpoint.
5. Invoke `sam build` with the generated template.
6. Use `sam deploy --guided` for the first deployment so AWS settings are reviewed and saved.
7. Use `sam deploy` for subsequent deployments and return SAM's exit status.

Proposed configuration:

```yaml
deploy:
  lambda:
    region: ap-northeast-1
    runtime: nodejs24.x
    http:
      auth: aws-iam
```

The current implementation creates a Lambda Function URL and defaults to `AWS_IAM`. Set `http.auth: none` explicitly for public access. Lambda scheduled-handler adaptation exists, but EventBridge resource generation is not automated yet.

## Azure Functions

Install the target package in the App before deployment:

```bash
npm install -D @nosrv/azure
# Add when providers.azure.db uses PostgreSQL.
# npm install -D @nosrv/postgres
```

Current command:

```bash
nosrv deploy --target azure --dry-run
nosrv deploy --target azure --app FUNCTION_APP_NAME
```

Azure Functions Core Tools v4 must be installed, Azure CLI authentication must be active, and the target Function App must already exist. The generated Node.js programming model v4 project is placed under `.nosrv/azure/deploy/` with a bundled Web-standard HTTP adapter, copied static assets and private resources, `host.json`, and code-based Timer registrations.

`--dry-run` only generates the staging directory. Normal deployment delegates to `func azure functionapp publish`. nosrv does not create the subscription, resource group, hosting plan, Function App, storage account, databases, containers, IAM/RBAC, or networking.

Optional non-secret deployment defaults can be stored in `nosrv.yaml`:

```yaml
deploy:
  azure:
    app: my-function-app
    authLevel: function
    # slot: staging
```

Secrets and environment values stay in Function App settings or Key Vault references and need no declaration in App code. Do not put secret values in `nosrv.yaml`. Configure non-secret resource identifiers under `providers.azure`: Blob Storage uses a container and `AZURE_STORAGE_CONNECTION_STRING` by default, Cosmos DB KV uses a database/container and `AZURE_COSMOS_CONNECTION_STRING`, and PostgreSQL uses `DATABASE_URL`. Environment variable names are configurable. Each five-field UTC nosrv schedule is registered as a six-field Azure NCRONTAB expression by prepending seconds (`0`). Timer coordination relies on `AzureWebJobsStorage`; failed timer invocations are not automatically retried.

## Shared implementation requirements

- Keep generated files under `.nosrv/` and out of application source.
- Fail with an actionable message when a required official CLI is unavailable.
- Provide a non-publishing validation path before real deployment.
- Preserve official CLI output, prompts, and exit codes.
- Never print secret values or place them in generated source.
- Document which resources are created, updated, retained, or deleted by the delegated tool.
