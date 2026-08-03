import { defineApp } from "@nosrv/core";

export default defineApp({
  fetch() {
    return Response.json({ ok: true });
  },

  scheduled(event, ctx) {
    ctx.log.info("Scheduled task ran", {
      name: event.name,
      cron: event.cron,
      scheduledTime: new Date(event.scheduledTime).toISOString(),
      trigger: event.trigger,
    });
  },
});
