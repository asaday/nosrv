# Full configuration example

This App is intentionally verbose. Its `nosrv.yaml` shows the supported application, private packaged resources, local development, schedule, provider, and deployment settings in one place. Normal nosrv Apps should omit values that match defaults.

Run it locally:

```bash
npm run dev
```

Deploy it to a local nosrv Platform:

```bash
nosrv login --url http://127.0.0.1:3100
npm run deploy
```

Cloud resource names and IDs are placeholders. Create the corresponding resources and replace those values before cloud deployment. Google Cloud Scheduler and AWS EventBridge provisioning are not automated, so the declared schedule must be provisioned separately for those targets.
