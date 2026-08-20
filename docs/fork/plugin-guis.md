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

## What would change in T3

Deliberately small, because the value is in what already exists.

1. **A plugin record** in settings: name, URL, icon, and the scopes it may be
   given. Contracts already carry provider settings of this shape.
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
command, or a view; it gets a rectangle and an API token. That is a real ceiling
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
