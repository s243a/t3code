# Our plugin design, read against upstream's

> **Fork-local.** A comparison, not a proposal. [plugin-guis.md](plugin-guis.md)
> stays as written; this says what of it survives contact with the runtime
> upstream is actually building.

## Where upstream is

Six open pull requests against `pingdotgg/t3code`, none merged:

| PR           | What                                                        | Opened     |
| ------------ | ----------------------------------------------------------- | ---------- |
| #6158        | local plugin system with shareable git sources (`yemirhan`) | 2026-08-11 |
| #7448, #7450 | **spikes** comparing plugin runtime models                  | 2026-08-18 |
| #7480        | production plugin runtime                                   |            |
| #7549        | plugin command catalog                                      |            |
| #7613        | plugin package lifecycle                                    |            |

Written agent-assisted, co-authored by Utkarsh Patil — a real contributor with
around forty commits on `main`, though not one of the two principals.

Two things follow. The design is **not settled**: two of the six are explicitly
spikes comparing models, and a separate contributor has a competing approach. And
ours was **last**, not first — upstream's spikes predate our document by two days
and the community PR by nine. There is no question of who should conform.

## What upstream's runtime commits to

From `packages/plugin-runtime`:

- **Contributions are declarative.** A plugin registers detached, deeply frozen,
  JSON-compatible metadata, plus an optional _host-only_ live value.
- **Executable values never cross the RPC boundary.** Snapshots and
  `contributions(slot)` expose frozen metadata only.
- **Invocation is generation-checked.** A host passes the committed generation to
  `useContribution(...)`; a stale caller fails rather than reaching a handler
  from a different composition.
- **One Effect child scope per plugin**, shutdown owned by the composing scope.
- **Atomic publication with rollback** — a failed activation does not replace the
  live composition.
- Cordis was considered and rejected; a pure-only executor was rejected because
  plugin lifetimes and async cleanup should belong to Effect scopes.

## What survives, and what does not

### The core inversion is answered — differently, and better

Our document argues at length for _"the plugin emits, T3 acts"_: T3 polls the
plugin for events, and those events trigger host actions. We reached that by
asking what a plugin should be allowed to demand of its host, and concluded that
the plugin should never call in.

Upstream reaches the same safety property by a different route. A plugin does not
emit and is not polled; it **declares contributions**, and the host invokes them
under a generation check. The plugin still never calls into T3 — but there is no
event loop, no polling overhead, and no queue to drain. The overhead objection
that our own document raises against polling simply does not arise.

**Our reverse-proxy section should be treated as superseded.** It solved a real
problem, and upstream solved it without the machinery.

### The trust-level argument survives, and has nowhere to live yet

Our longest section argues that plugins need trust levels — that "store this
token" and "read this token" are different permissions requiring different
grants, and that this implies a plugin manager which warns before elevation.

Nothing in what upstream has published addresses this. The runtime is a
composition and lifecycle mechanism: it decides what is live, what is frozen, and
who may invoke. It does not say which plugin may ask for what.

That is the part of our design worth keeping and, eventually, proposing — not as
a competing runtime, but as a layer above one that exists. It also becomes easier
to state against their model: a contribution slot is a natural place to attach a
required trust level, since slots are already the unit the host reasons about.

### The signing and registry argument is unaffected

Plugin identity, keeping keys after uninstall, verifying a signature from
somewhere else — none of it is touched by a runtime contract, and all of it still
applies. Already deferred in our document as non-urgent.

### "Executable values never cross the RPC boundary" is stricter than we assumed

Our design assumed the risky direction was _T3 reaching into a plugin_. Upstream
forbids the reverse as well: a live value stays host-only and never reaches a
snapshot. That is a stronger position than ours and worth adopting rather than
arguing with.

## Could a plugin fetch and install a credential? No.

Worth answering concretely, because it is the thing we would want a plugin for.
The command contract is deliberately small:

```
PluginCommand                  { id, label, description?, surfaces[] }
PluginCommandInvokeInput       { generation, id }            ← no arguments
PluginCommandInvocationResult  { message ≤500 chars, tone: "info" | "success" }
```

A command takes no input beyond its own id and returns a sentence. Nothing
structured comes back, and nothing in the contract lets a plugin write host
state.

A handler _could_ act — it runs host-side in the plugin's own Effect scope, so it
could reach a local peerhailer daemon and fetch a grant. It simply cannot hand
the result to T3. Putting the credential in the message means displaying a bearer
token in a toast, which is the clipboard problem with worse ergonomics and a
longer life.

Doing this properly needs a **slot that does not exist** — a credential or
environment provider, something the host would invoke to obtain a connection
rather than to show a message. That is a specific thing to watch for rather than
a general hope.

It also settles the question below for a better reason than convenience:
peerhailer does not need a T3 plugin for the credential path **because the plugin
system could not do it even if it were merged.**

## What this means for peerhailer

**Do not build a plugin system in this fork.** Six open PRs and two competing
models is exactly the moment when a fork's own implementation becomes permanent
divergence.

**Do not write peerhailer against the contract yet, either.** It is unmerged and
being compared against alternatives; the shape may not survive.

And most usefully: **peerhailer does not need a plugin for the thing it is for.**
T3 already connects to a remote instance through a saved environment — a URL and
a credential. What is missing is a safe way to get the credential there, which is
peerhailer's job over an authenticated peer link, and a person pastes it at the
end. A plugin removes the paste. It does not unlock the feature.

That paste is also less bad than it looks: what crosses is short-lived and
scoped, and a grant is bound to the receiving machine's key, so a copy is worth
nothing anywhere else.

## What to watch

- Whether #7480 or a different model wins the spike comparison.
- Whether contributions ever gain a permission dimension, which is where our
  trust-level work would attach.
- Whether a slot appears that returns _data_ rather than a message — a credential
  or environment provider is the one that would make the peerhailer case work.
- Whether #6158's git-sourced plugins land, since "where a plugin comes from" is
  the question our signing section answers.

## Where this leaves the fork

**Short term: build neither.** Not a plugin system, and not the credential path a
plugin would have carried. Four things we planned turned out to exist already —
short-lived one-time tokens (`t3 pair --ttl`, five minutes by default), delivery
as a QR code that touches no clipboard, `--tailscale` pairing through an HTTPS
tailnet URL, and Tailscale itself as an authenticated machine-to-machine channel.
Each is faster to adopt than to write, and none of it is ours to maintain.

The one small thing worth contributing upstream is `t3 pair --json`: the command
renders a terminal QR unconditionally, so anything scripting around it is
grepping ANSI art. One flag, in their "small, focused" bucket.

**Medium term: decide between upstream's runtime and our own**, against criteria
rather than taste. Ours is only worth building if theirs cannot answer:

1. **A permission dimension on contributions.** Our trust-level argument — "store
   this token" and "read this token" are different grants — has nowhere to attach
   in what upstream has published.
2. **A slot that returns data rather than a message.** A command takes no
   arguments and returns 500 characters and a tone, so a plugin can fetch a
   credential and cannot hand it over.
3. **Whether the model settles at all.** Two of the six open PRs are spikes
   comparing runtimes, and a separate contributor has a competing approach.

If those land, we write a plugin against their contract and maintain nothing. If
they do not, that is the point to reconsider — with a working peer fabric behind
us and a clearer idea of what the plugin would be for.

**The lesson worth keeping**, since it cost several hours to learn: check what
exists before designing what to build. The fabric's real justification survived
this — driving an agent on another machine, reviewed by a human, is not something
Tailscale or T3 provides — and the credential story did not.
