# Scheduled App example

This App combines a normal HTTP handler with an idempotent `scheduled(event, ctx)` handler. The named five-field cron expression in `nosrv.yaml` uses UTC.

```bash
npm run dev
curl http://127.0.0.1:8787/
```

The local runtime triggers `every-five-minutes` while it is running. Public-cloud HTTP deployment does not currently provision Cloud Scheduler or EventBridge resources automatically; create the corresponding scheduler separately.

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```
