# Photo diary App example

A fuller nosrv App combining a plain HTML frontend, router, database, object storage, optional user identity, multipart forms, and bounded uploads.

```bash
npm run dev
```

Open <http://127.0.0.1:8787/>. Without an identity provider, local requests use a demo user. SQLite data and uploaded photos persist under `.nosrv/`. Cloudflare deployment requires provisioned D1 and R2 resources.

The App limits the complete multipart request and also validates the uploaded file size and declared media type. MIME type alone is not proof of file contents in a security-sensitive application.

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```
