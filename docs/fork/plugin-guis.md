# Plugin GUIs in T3 Code

> **Fork-local design.** Specific to the `s243a/t3code` fork, not proposed for
> upstream. Written at the level of _what it should do and why_; the
> implementation section names the smallest change that would work.

## The problem

T3 has no plugin system. Providers are a static array — `BUILT_IN_DRIVERS`,
resolved at build time, each driver's service requirements satisfied by the
runtime layer's type — and nothing anywhere loads code at runtime. So "add a
plugin" today means editing T3's source, which is a fork patch rather than a
plugin, and every such patch is one more thing to carry across an upstream
rebase.

Meanwhile the things people want to add — a peer directory, a tunnel manager, a
file-transfer view — are mostly _interfaces to something already running
elsewhere_. They do not need to be inside T3. They need a way in and a way to be
opened.

That suggests the cheapest useful integration point is not a plugin API at all.
It is **a button that opens a page**.

## What T3 already has

Enough that this is mostly assembly rather than construction.

**An embedded browser, already sandboxed.** `DesktopWindow.ts` intercepts every
webview attachment:

```js
window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
  if (!previewManager.isBrowserPartition(params.partition)) {
    event.preventDefault();
    return;
  }
  webPreferences.sandbox = true;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = false;
});
```

A page opened this way runs in its own sandboxed process with no Node
integration, in a partition T3 assigns, and cannot reach T3's DOM, React tree,
stores, or `window.desktopBridge`. An attachment with an unrecognised partition
is refused outright, so a webview cannot be conjured by injecting markup.

**An API that expects to be called from elsewhere.** `httpCors.ts` sets
`access-control-allow-origin: *` and allows the `authorization` header. The
wildcard is safe precisely because the bearer token authorises rather than the
origin.

**Scopes that are enforced centrally and separable.**
`RpcAuthorization.ts:129` throws at startup for any RPC without a declared
scope — the same instinct as refusing a plugin route that declares no
capability. And the scope list is fine-grained enough to be useful:
`orchestration:read`, `orchestration:operate`, `terminal:operate`,
`review:write`, `access:read`, `access:write`, `relay:*`.

**A way to reach into a page.** `PreviewAutomationHosts.tsx` calls
`webview.executeJavaScript(...)`.

## The idea

The trust boundary is asymmetric: the host can reach into the page, the page
cannot reach into the host. Rather than working around that, use it.

**T3 opens the page, then injects the credential.** The plugin GUI never asks
for a token, never stores one, and has no endpoint to fetch one from. When T3
opens the window it injects a short-lived, narrowly-scoped bearer token into the
page. The page then talks to T3's ordinary API with that token, and to whatever
local service it fronts on its own address.

This is the mint-on-demand pattern from the peer-fabric work, applied across a
different boundary: **the directory holds a grant, the credential is made when
it is needed**, and it stops working shortly afterwards. A "fetch token"
endpoint would be a way to obtain a credential by asking; there is no need for
one when the host hands it over as it opens the door.

```
  ┌──────────────┐  opens webview, injects scoped token   ┌───────────────┐
  │   T3 Code    │ ────────────────────────────────────▶  │  plugin page  │
  │              │                                        │  (sandboxed)  │
  │   HTTP API   │ ◀──── calls with that token ────────── │               │
  └──────────────┘                                        └───────┬───────┘
                                                                  │ loopback
                                                          ┌───────▼───────┐
                                                          │ local service │
                                                          │ (peerhailer…) │
                                                          └───────────────┘
```

Note which arrows do _not_ exist. The local service never talks to T3, and T3
never talks to the local service. Each is independently useful, and neither
needs credentials for the other. The page is the only thing that knows both, and
it is the most disposable part.

## The better inversion: the plugin emits, T3 acts

The design above puts a token in the page. There is a variant that does not, and
it is stronger for exactly that reason.

**The plugin publishes events; T3 consumes them and performs the action.** The
page never holds a credential — nothing to leak, no scope to get wrong, no
expiry to manage — because it never calls T3's API at all. It says _what
happened_, and T3, which already has every privilege it needs, decides what to
do about it.

```
  ┌──────────────┐   subscribes to events    ┌───────────────┐
  │   T3 Code    │ ◀──────────────────────── │  plugin page  │
  │              │                           │  or service   │
  │  acts on its │                           │               │
  │  own behalf  │  (no credential outbound) └───────────────┘
  └──────────────┘
```

An event is a **request, not an instruction**: T3 decides what to do about it,
and may decline.

### Which credentials T3 may accept, and why "never" was wrong

An earlier draft said T3 should refuse "store this token" on principle. That is
too strong, and it breaks the feature: **discovering another T3 instance is
useless if T3 cannot then connect to it**, and connecting needs a credential
that has to arrive somehow. Refusing all of them leaves the user copying pairing
URLs by hand, which is the friction this was meant to remove.

The distinction that actually matters is **which way the authority points**.

**A credential over _this_ machine must never be accepted from a plugin.** A
session for this environment, an entry in its authorised clients, anything that
lets somebody _in_ here. Accepting one makes the page's compromise this
machine's compromise, and there is no version of that trade worth making.

**A credential over _another_ machine is a different object.** A saved remote
environment is outbound authority: it lets this T3 act _there_. It grants
nobody access _here_. Storing one is closer to storing a bookmark that happens
to have a key attached, and the honest risk is not escalation but **being lured
somewhere hostile** — a compromised plugin could offer an environment belonging
to an attacker, and a user who opens it sends their prompts and code into it.

### Carrying it this way is safer than what people do now

Worth saying, because the feature reads as convenience and is not only that.

Today a pairing token gets from one machine to another by being **copied and
pasted**, and that path is worse than it looks:

- **Any process can read the clipboard.** On the usual desktops it needs no
  permission and leaves no trace.
- **Clipboard managers keep history**, often on disk, usually unencrypted,
  frequently searchable — a credential that was meant to be transient becomes a
  file.
- **It rarely stays on one machine.** Getting a token from a box in another room
  to a laptop generally means a chat message or an email, which puts a
  credential on somebody else's server, in their logs and their backups.
- **Screens are shared and photographed**, and the token is on one.

The peer path is better on every one of those. The credential travels over a
channel already authenticated by key between two machines that have each
admitted the other; it is minted on demand, short-lived, and stored nowhere in
between; it never reaches a clipboard, a chat log, or a third party; and it
cannot be delivered to the wrong machine, because the channel knows which
machine it is talking to.

Two caveats, so this is not oversold:

**An intermediary must not be able to read it.** Delivered directly between two
peers this holds already. Carried by a relay it does not, unless the relay is a
dumb forwarder over an end-to-end encrypted channel — which the peer-fabric
design requires of relaying for exactly this reason.

**Automation removes a human check.** Copy-and-paste has one virtue: a person
sees the thing being moved and where it is going. An automatic path removes that
glance, which is why provenance and a deliberate connect step below are not
polish. They are what replaces the check that automation took away.

That is a real risk and a different one, and it is answered differently:

- **Provenance travels with the environment.** It arrives named as the peer it
  came from, with that peer's key fingerprint, because "sol offered this" is
  what a person can actually judge.
- **Connecting stays deliberate.** An environment may appear in the list without
  anything connecting to it. The lure only works if opening is automatic.
- **The credential is minted at the far end, on demand, and briefly.** The
  remote T3 issues it when asked, scoped and short-lived; the peer fabric
  carries it over an authenticated channel and stores it nowhere. That is the
  same rule the directory already follows — hold the grant, make the credential
  when it is needed.

So the shape is: a plugin may tell T3 _where a machine is and who vouched for
it_, and may carry a credential **for that machine** minted by that machine. It
may never hand T3 authority over T3.

### Polling is the obvious cost, and it is avoidable

Polling is real overhead for something that is idle almost always: a request
every few seconds, all day, to be told nothing happened.

Server-Sent Events remove it without new machinery. T3 opens one long-lived
`GET`, the plugin writes events as they occur, and an idle connection costs a
socket and a periodic keep-alive. It is plain HTTP, it survives the webview
sandbox, it reconnects by itself, and it needs no WebSocket upgrade path or
second protocol. A plugin that would rather not hold a connection open can still
be polled; the consumer does not care which.

### What the inversion asks for instead

Removing the credential moves the burden rather than deleting it, and the new
obligations are worth stating.

**T3 must authenticate the source.** If it subscribes to a loopback address,
anything that can occupy that port can feed it events. The plugin should sign
what it emits with a key T3 pins when the plugin is configured — which
peerhailer already has, since identity there is a signing key. Pinning on
configure is the same trust-on-first-use decision as admitting a peer, made once
and deliberately.

**Events need acknowledgement and identity.** A reconnecting consumer must not
replay what it already acted on, so each event carries an id and T3 records how
far it has read. Delivered-twice is the normal case for a stream that can drop;
acted-on-twice must not be.

**A stream is a queue somebody else fills.** A compromised or buggy plugin can
emit as fast as it likes. Bounded buffers, a rate limit, and a plugin that can
be muted without being removed.

**Latency is now the plugin's problem, not the poller's.** Which is the right
place for it: the side that knows something happened is the side that says so.

Neither variant is strictly better. Token injection is fewer moving parts and
suits a plugin that mostly _reads_ T3. Event subscription suits a plugin that
mostly _tells_ T3 things, and is the one to prefer wherever the page would
otherwise hold a credential — which is most of the time.

## Rules

**Scope down, always.** A peer-directory plugin needs `access:read` at most; it
has no business holding `terminal:operate`. Injecting a standard-scoped token
because it is convenient hands a web page a remote shell. Token exchange already
exists (`AuthTokenExchangeGrantType`) and is the mechanism for narrowing.

**Bind the token to the window, and expire it.** Minutes, not the session. A
token that outlives the window it was minted for is a stored credential, which
is the thing this design is avoiding.

**Each plugin gets its own partition.** Storage, cookies and service workers
stay separate, so one plugin page cannot read another's state — and a
compromised plugin cannot reach the browser state of the rest.

**Watch which way authority points, not whether a credential is involved.** A
plugin may carry a credential for _another_ machine, minted by that machine —
that is outbound authority and the reason the integration is worth having. It
may never supply one that grants access to _this_ machine. See the discussion
above; the first version of this rule refused both and quietly made the feature
pointless.

**The plugin list is configuration, not discovery.** A name, a URL, an icon,
entered deliberately. Nothing scanned, nothing auto-registered. A tool that
decides who may talk to your machines should not open a page because it appeared
somewhere.

## Plugins need trust levels, which means a plugin manager

Once a plugin may do more than display a page, "is it installed" stops being one
question. Showing a directory and handing T3 a credential are not the same
grant, and a single on/off switch makes the smaller one carry the weight of the
larger.

So a plugin holds a **level**, and each capability names the level it requires.
This is the same model as the peer fabric's capability profiles, arrived at from
the other end, which is some evidence it is the right shape.

| Level              | May                                                                            | Risk if the plugin is compromised              |
| ------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `view` _(default)_ | be opened, and nothing else                                                    | it shows you something false                   |
| `observe`          | read non-credential state: which environments exist, their names and addresses | it learns your machine list                    |
| `offer`            | add an environment, with a credential **for that machine**                     | it lures you into connecting somewhere hostile |
| `invite`           | ask T3 to mint a **new** pairing credential for _this_ machine                 | it can let others in here                      |

Default is `view`, and defaulting anywhere else would make the level cosmetic.

### Why "read" outranks "store"

The instinct is that writing is more dangerous than reading. Here it is the
other way round, and the reason is what each grant produces.

**Storing** gives this T3 outbound authority over a machine the plugin chose. It
grants nobody access here, it is visible in the environment list, and it is
undone by deleting an entry. At worst you were pointed somewhere you should not
go.

**Reading** takes authority the user already established and hands it to
software. One extracted credential may cover machines the plugin never
discovered and was never told about, it works after the plugin is removed, and
nothing about it appears in the interface. That is exfiltration, and it does not
undo.

### A refinement: mint new, never read existing

There is a legitimate need behind "read token" — inviting another machine to
connect to _this_ one means a credential has to leave here. But that need is met
by **minting a fresh one**, scoped and short-lived, at the moment of the
invitation.

So the top level is `invite`, not `extract`: a plugin may ask T3 to _make_ a
credential for this environment. It may never read the ones already stored.
Those cover other machines and were established for other reasons, and no
integration needs them.

Which removes the exfiltration primitive entirely while keeping the feature.
A compromised plugin at `invite` can let someone into this machine, which is
serious and is why it is the highest level — but it cannot quietly drain the
access you already had.

### What the manager has to do

A level per plugin implies somewhere to set it, which is the plugin manager this
design was trying to avoid needing. It is still small:

- **List, add, remove.** Name, URL, level, and the signing key pinned when the
  plugin was configured.
- **Change a level deliberately, and warn when it is elevated.** See below.
- **Show what a plugin did.** Environments it offered, credentials it asked to
  have minted, when, and whether anyone connected. A grant nobody can review is
  a grant nobody can revoke with confidence.
- **Mute without removing.** The equivalent of blocking a peer: keep the
  configuration, stop honouring it, while something is investigated.

### Two kinds of signing, which are not the same thing

"Signed plugin" has been doing two jobs above, and they answer different
questions. Keeping them apart matters, because a plugin that is signed in one
sense and trusted as though it were signed in the other is worse than one
nobody signed at all.

**A service key answers "is this still the thing I configured?"** It signs the
events the plugin emits, is pinned when the plugin is added, and is checked on
every exchange. It is trust on first use — the same decision as admitting a
peer — and it proves continuity, not provenance. It says nothing about who
wrote the plugin.

**A publisher key answers "did this come from who it claims?"** For a plugin
that is a URL rather than a downloaded artifact, what gets signed is a
**manifest** — name, URL, the service key it will present, the level it asks for
— fetched and checked against a key published somewhere the publisher controls
and an attacker would have to compromise separately: the project's repository,
a well-known path on its own domain, a keyserver.

They compose. The publisher key establishes what the service key _should_ be;
the service key proves you are still talking to it. Neither substitutes for the
other, and a manifest signature checked once at install proves nothing about the
service answering next week.

### A registry that remembers, including what it uninstalled

Keys should outlive the plugins that presented them, unless a person clears
them. Retention is what turns a reinstall into a **comparison** rather than a
fresh first impression: the same name arriving with a different key is either a
rotation or a substitution, and only one of those should be quiet.

This is `known_hosts`, and worth copying with its lessons rather than its
implementation:

- **The warning has to be specific and rare.** SSH's host-key warning is famous
  and famously scrolled past, because it looks the same whether a key rotated or
  a machine was replaced.
- **Legitimate rotation needs a path that is not "delete the entry".** A
  rotation statement signed by the _old_ key is the clean version: the plugin
  proves it is the same publisher choosing a new key. Where that is unavailable,
  clearing is an explicit act with the old fingerprint shown beside the new one.
- **Removal is not forgetting.** Uninstalling a plugin drops its
  configuration; the key stays, marked as belonging to something no longer
  installed, until someone clears it deliberately.

### Corroborating a key without inventing an authority

A signing authority is the conventional answer and a poor fit here: it means a
third party, its own compromise, and machinery out of proportion to a fabric of
personally-owned machines.

There is a cheaper source of corroboration already present. **Ask your own
peers what key they saw.** A machine that has the peer fabric can ask the
machines it already trusts whether they hold the same publisher key for a
plugin, and a substitution then has to have reached all of them rather than one.

Two limits, stated so this is not mistaken for a chain of trust:

- **Corroboration is not authority.** Agreement among peers raises confidence;
  it does not establish provenance, and a key nobody else has seen is not
  thereby wrong.
- **Correlated compromise defeats it.** Machines that all fetched from the same
  poisoned source agree perfectly. It is evidence about independence, and only
  as good as the independence is real.

And the rule the fabric already holds applies here too: this may inform a
person's decision, never make it. A key agreed by every peer you have is still
a key somebody chooses to pin.

### Deferred: signing the plugin's code

Worth having, not a priority, and it needs one change to become meaningful.

A plugin here is a **URL**, and what a URL serves can differ on every load.
There is no artifact to sign, so the nearest equivalents are poor: pinning a
hash of the page fights every legitimate update, and signing a manifest —
which the design already does — attests to what a plugin _claims_, not to the
code it runs.

Code signing becomes meaningful when a plugin is distributed as an **artifact**:
a release someone downloads, verifies against a publisher key, and serves
locally from the verified copy. That is a coherent model and a different one,
with its own weight — versions, updates, a place to keep them — and it should be
adopted because artifact distribution is wanted, not to make a signature
possible.

Until then the three checks that exist do most of the work: the publisher key
says where the plugin came from, the service key says it is still the same
thing, and the trust level bounds what a compromised one could do. Signing the
code would narrow the remaining gap — a legitimate publisher serving altered
code — which is real and is not the gap most likely to be exercised.

### Warning about elevation, without training people to click through

`offer` and `invite` deserve a warning. Getting one to work is mostly about
restraint, since a warning shown too often is a warning nobody reads — and the
habit it builds transfers to the one that mattered.

**Warn on the change, not on the use.** Raising a plugin to `invite` is a
decision; every subsequent action under it is a consequence of a decision
already made. Prompting each time trains people to dismiss without reading, and
the dismissal becomes reflex precisely when it should not be.

**Say the consequence, not the category.** "Grants elevated permissions" tells
nobody anything. _"This plugin will be able to let other machines connect to
this one"_ is a sentence a person can weigh, and weighing it is the entire
point of asking.

**Do not warn about `view` or `observe`.** Warning on the harmless levels is
what makes the warnings worthless. A dialog that appears for everything teaches
that dialogs mean nothing.

**Make the safe choice the resting one.** The dialog opens with the change not
yet made; nothing should be pre-selected toward elevation, and nothing should
proceed on Enter.

**Warn again if the plugin changed.** A new URL or a different signing key is a
different plugin wearing a familiar name, and the level it inherited was granted
to something else. Re-pinning is a re-decision.

**Keep it visible afterwards.** A one-time dialog that leaves no trace is a
grant nobody can review later, and the list is where somebody will look. An
elevated plugin should be marked as elevated wherever it appears — the warning
is the moment, the marking is the memory.

## What would change in T3

Deliberately small, because the value is in what already exists.

1. **A plugin record** in settings: name, URL, icon, pinned signing key, and its
   trust level. Contracts already carry provider settings of this shape.
2. **A button, and a place for it.** Most naturally beside the existing browser
   surface, since that is the machinery being reused.
3. **A partition per plugin**, named so `isBrowserPartition` accepts it and one
   plugin cannot read another's storage.
4. **Token minting on open**: exchange the session's credential for one narrowed
   to the plugin's declared scopes, short-lived, injected via the existing
   `executeJavaScript` path.

That is a handful of files, and no change to the provider model, the
orchestration layer, or anything upstream rewrites often — which matters for a
fork that wants to keep taking upstream changes.

## What this is not

**Not a plugin API.** Nothing runs inside T3. A plugin cannot add a provider, a
command, or a view; it gets a rectangle and whatever its level permits. That is a real ceiling
and the reason it is cheap — plugins of this kind cannot break T3, because they
are not in it.

**Not a way to run untrusted code safely.** The sandbox is Electron's, the token
is real, and a malicious plugin page can do whatever its scopes permit. Adding a
plugin is a decision of the same weight as installing anything else; the scoping
bounds the damage rather than preventing it.

**Not mobile.** Webviews are a desktop mechanism. The web client would need an
iframe with its own analysis — cross-origin by default, which is stricter, but
`executeJavaScript` does not exist there, so the token would have to arrive
another way (a fragment on the URL, consumed and stripped, as pairing already
does).

## First consumer

[peerhailer](https://github.com/s243a/peerhailer) already serves a
self-contained page on loopback, showing which machines are known, which are
reachable, and what each is permitted. Pointing a T3 webview at it is the whole
integration on this side, and requires nothing of peerhailer at all.

The step after that — a peer picker beside the pairing-token field in
`ConnectionsSettings.tsx`, fed by peerhailer's local API — is where the two stop
being adjacent and start being useful together. It needs the "store" direction
above, and should not be attempted before that direction is settled.

## Open questions

- **Where does the button live?** Beside the browser tabs, in Settings, or in
  the command palette. Probably all three eventually, which the "hit every
  surface" rule would insist on anyway.
- **Should a plugin be able to request a scope it was not configured with?**
  Simplest answer is no, and re-configuring is cheap. A prompt-on-demand flow is
  more flexible and one more thing to get wrong.
- **What happens when the page is unreachable?** A plugin fronting a local
  service will often open before that service is running. It should look like a
  service that is down, not like T3 is broken.
