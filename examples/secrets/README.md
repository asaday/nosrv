# Secrets example

This small, single-file App shows the difference between ordinary environment configuration and a deployment secret. Its handler lives at the root as `app.ts`; environment and secret names are runtime configuration, so they are not declared as App capabilities. The response returns only whether the name is visible through each API, never its value.

## Local Node development

```bash
cp .env.example .env
npm run dev
curl http://127.0.0.1:8787/
```

`nosrv dev` loads `.env` into the local Node process. For development convenience, those values are available through both `ctx.env` and `ctx.secrets`, so the response is:

```json
{ "secretConfigured": true, "environmentConfigured": true }
```

This does **not** mean that `.env` provides secret isolation: it is ordinary local process environment. Keep `.env` out of the repository and use the deployment target's secret-management mechanism in production.

## nosrv Platform

Deploy the App, then configure its secret separately:

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
printf '%s' 'replace-me' | npx nosrv secrets set secrets GREETING_SECRET --stdin
curl http://127.0.0.1:3100/apps/secrets/
```

The Platform injects an App secret only through `ctx.secrets`; it does not copy it into `ctx.env`. The response therefore distinguishes it from local `.env` loading:

```json
{ "secretConfigured": true, "environmentConfigured": false }
```

Use `ctx.env` for non-sensitive runtime configuration and `ctx.secrets.get()` for secret values. Neither requires a declaration in `nosrv.yaml`.

## Public-cloud adapters

Provider-specific development entrypoints are available as `npm run dev:cloudflare`, `npm run dev:google`, and `npm run dev:lambda`. Configure the secret with each target's environment or secret-management mechanism before deployment.

For a deployed Cloudflare Worker, register the secret separately with Wrangler:

```bash
npx wrangler secret put GREETING_SECRET --config .nosrv/cloudflare/wrangler.jsonc
```

Run `npm run dev:cloudflare` or a Cloudflare deployment once to generate the Wrangler configuration. The command above configures Cloudflare; nosrv does not create or update the secret automatically.
