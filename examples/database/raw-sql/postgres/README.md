# PostgreSQL raw SQL example

This App uses the `db.sql` escape hatch with a PostgreSQL provider. The application keeps provider code in `app.ts`, while its schema intentionally uses PostgreSQL `BIGSERIAL`. Use the parent Database example for dialect-independent CRUD.

Create a database, copy the example environment file, and start the App:

```bash
cp .env.example .env
npm run dev
curl -X POST http://127.0.0.1:8787/ -d 'hello postgres'
curl http://127.0.0.1:8787/
curl http://127.0.0.1:8787/environment
```

`DATABASE_URL` is loaded from `.env`, used only to construct the provider, and hidden from `ctx.env`. The provider creates an App-specific schema named from `providers.node.db.appId`; it does not create the PostgreSQL database or manage migrations, credentials, TLS, backups, or availability.

The same App can run through the Google Functions and Lambda development adapters:

```bash
npm run dev:google
npm run dev:lambda
```

Both use `DATABASE_URL` and the PostgreSQL configuration for their selected target. A deployed function must be able to reach the database and receive the connection URL through provider-managed environment or secret configuration.

Deploying this App to nosrv Platform uses the Platform operator's configured database backend rather than `providers.node`. Configure the Platform-wide PostgreSQL backend when PostgreSQL is required there.

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```
