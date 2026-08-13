# Why nosrv?

## AI makes Apps easier to create, not easier to keep

AI can generate a useful Web App quickly. After the code works, the App still needs a place to live:

- a route and an execution process;
- persistent data and backups;
- secrets and external-service credentials;
- user identity and access policy;
- logs, updates, rollback, ownership, and removal.

For one prototype, these surroundings can be assembled directly. When a team creates many small Apps, every App-specific combination becomes another service that someone must understand and operate.

AI therefore changes the scale of the problem. When Apps become inexpensive to create, their operational differences can accumulate faster than a team can govern them.

> AI can create an App. nosrv gives it a prepared, managed place to live.

## Small is an operational boundary, not a small business outcome

Business work is rarely one indivisible application. Intake, review, approval, records, search, reporting, notifications, and integration often change at different rates and have different users, owners, data, and permissions. Forcing every variation into one large application can make a local change depend on a system-wide release; leaving every variation as an unrelated script creates the opposite problem of fragmented operations.

In nosrv, a small App is a focused unit that can be understood, owned, deployed, updated, and stopped independently. Several Apps may support one larger business workflow, while systems of record continue to own shared authoritative data and core transactions.

```text
System of record
       ↓ authoritative data and core transactions
Focused Apps
       ↓ intake, review, search, transformation, notification
nosrv Platform
       ↓ shared runtime, identity, capabilities, and lifecycle
People doing the work
```

Splitting a workflow does not make integration automatic. Cross-App contracts, the authoritative source for each record, identity propagation, authorization, retries, consistency, and failure recovery still need explicit design. nosrv provides clear App and operational boundaries; it does not pretend that distributed business logic is free.

> Build Apps small. Operate them as one.

## Write what makes the App unique

A nosrv App concentrates on its own behavior:

```ts
export default defineApp({
  requires: { db: true, tools: ["slack"] },

  async fetch(request, ctx) {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const messages = await ctx.tools.slack("search_messages", { query });
    await ctx.db.insert("searches", { query, createdAt: new Date() });
    return Response.json(messages);
  },
});
```

The App asks for a database and a logical Slack capability. It does not select the Platform database backend, embed the Slack connection URL, or define organization-wide tool policy.

The App declares the logical integration it needs through `requires.tools`. The Platform operator separately decides how that tool group is implemented, authenticated, and constrained. `nosrv.yaml` stays focused on deployment metadata that cannot be expressed in code.

## One problem, three outcomes

### Build

The independent nosrv App specification gives people, Studio, and external coding agents the same small target. Apps use Web Standard `Request` and `Response`, optional scheduled work, and explicit capabilities for database, KV, storage, and Platform tools.

Studio is the reference browser experience for creating, validating, previewing, and deploying these Apps. It is optional and does not define a Studio-only App format.

### Protect

The easiest route should also be the safer route. The Platform can centralize identity, secrets, data providers, deployment authority, App access, and integration policy instead of asking every App author or generated codebase to implement them independently.

Capability declarations do not guarantee that an App is safe. Business authorization, input validation, dependency review, and stronger isolation for hostile code still require deliberate work. Platform guardrails reduce repeated dangerous choices; they are not a substitute for application security or a hostile-code sandbox.

### Operate

An App should remain manageable after its first successful request. The Platform gives Apps a common lifecycle for registration, routing, process supervision, versions, logs, secrets, schedules, access, rollback, stopping, and removal.

This prevents a management dashboard from becoming only a separate inventory. The same App contract that declares required capabilities is also what the Runtime validates and the Platform operates.

## Why the scope crosses familiar boundaries

An App specification alone leaves deployment, identity, data, and operations to every App. A Runtime alone still leaves connection and policy choices scattered. A management UI without a shared App contract becomes a catalog of unrelated services. An AI builder without a receiving environment produces source that still needs all of those surroundings.

nosrv connects the responsibilities that must agree:

```text
App specification
       ↓ declares behavior and required capabilities
Runtime
       ↓ executes the same contract
Platform
       ↓ supplies capabilities and manages the lifecycle
Studio or another authoring tool
       ↓ creates ordinary nosrv App source
```

The components remain separate, but the workflow does not stop halfway.

## Portable core, explicit environment dependencies

Complete portability is not the goal. Dependencies should be explicit and unnecessary coupling should be avoided.

- `Request`, `Response`, and the basic App contract form the portable core.
- Database, KV, and storage use common capability contracts with documented provider differences.
- A logical tool group such as `slack` is available only on Platforms that provide it.
- Provider selection, connection URLs, credentials, and organization policy remain Platform responsibilities.
- Apps that need stronger isolation, independent scaling, long-running jobs, or specialized infrastructure can move to a more suitable execution environment.

An App may depend on Slack without depending on a particular Slack MCP URL or credential-storage mechanism. That is useful separation even when the App is intentionally built for one company's Platform.

## Studio demonstrates the complete path

Studio exists so the complete value can be experienced without first assembling a separate editor, agent workflow, preview environment, and deployment process:

```text
Describe or edit an App
        ↓
Understand capabilities offered by this Platform
        ↓
Generate ordinary nosrv App source
        ↓
Validate and run a private Preview
        ↓
Review and deploy the same Artifact
        ↓
Manage the resulting App through the normal Platform lifecycle
```

The same App can instead be created by hand or with another coding agent, validated by the CLI, and deployed to the Platform. Studio is an optional reference experience, not the owner of the App specification.

## The short version

> Build small Apps without creating separate operations.

Write the behavior specific to the App. Let the Platform provide the runtime, data, identity, integrations, security guardrails, and lifecycle shared by the rest.
