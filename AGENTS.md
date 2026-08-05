# nosrv development

- Read `docs/ai-spec.md` before creating or substantially changing an application.
- Preserve the Web Standard `Request` and `Response` application contract.
- Declare required database, KV, and storage capabilities and use them through `ctx`; use runtime-provided `ctx.env`, `ctx.secrets`, and `ctx.user` without declaring them.
- Implement cron work with `scheduled(event, ctx)` and named five-field entries under `schedules` in `nosrv.yaml`; use an IANA `timezone` when required, and keep it short and idempotent.
- Keep portable application code independent of cloud-provider SDKs.
- Default to the basic frontend; use framework templates only when justified.
- Treat a root `index.html` as a valid static-only app; use `public` for arbitrary static file directories.
- Use `nosrv deploy` for the default self-hosted target. Interactive deployment uses a saved browser login; CI may pass an issued personal token through `NOSRV_TOKEN`.
- Update examples and tests when changing a public contract.
- Run `npm run format`, `npm run typecheck`, and the relevant tests before finishing.
