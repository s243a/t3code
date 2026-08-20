# A peer fabric for T3 Code

> **Fork-local proposal.** Specific to the `s243a/t3code` fork, not proposed for
> upstream. Deliberately written at the level of *what it should do*; the
> implementation section offers options rather than a decision.

## The problem, stated honestly

Earlier in this project I argued against adding P2P to T3: T3 already expresses
remoteness at the connection layer, Tailscale already solves NAT traversal, and
mesh *routing* would buy nothing because every hub is directly reachable once an
overlay exists.

That last clause is doing more work than it can carry, and the qualifier belongs
in the claim: routing buys nothing *where an overlay reaches every machine*. It
is the machines an overlay cannot reach that most need a fabric. See
**Deferred: peer relaying** below — the question is open, not closed.

What the argument does establish is that transport is not the **first** gap.

The gap is **provisioning**. Before a client can connect to a machine, something
has to be *running* on that machine. Today that means: open a shell there,
install T3 or the broker, start it, note the address, configure it. T3 has one
productized escape from this — desktop SSH launch, which starts a remote T3
server and pairs it — but it is desktop-only, SSH-only, and T3-server-only.
Nothing general exists for "make this machine start doing something for me."

That is the real friction, and it is worth naming precisely, because a fabric
that solves it looks nothing like a fabric that solves routing.

## What it should do

**Machines should offer themselves, not be configured.** Owning a machine and
wanting to use it should be enough. The act of installing the agent on a box is
the act of making it available; there should be no second step where a human
transcribes an address into a settings pane. Addresses are an implementation
detail that leaks today.

**Names should outlive addresses.** A laptop that moves between home, office,
and tether is the same laptop. Anything a user has named, approved, or scripted
against must survive the address changing underneath it. If a user ever has to
re-pair because they changed networks, the design has failed.

**A peer offers capabilities, not access.** This is the load-bearing principle
and the one most easily lost. "This machine will run a broker for you" is a
categorically different grant from "this machine will run whatever you send."
The fabric should carry *specific offers* — run a broker, run a T3 server, run
this named agent — each independently grantable and revocable. A peer that can
be asked to run arbitrary commands is a remote shell wearing a fabric costume,
and every safeguard built above it is theatre.

This mirrors a decision already made well elsewhere in this project:
`BROKER_TERM_CMDS=agy` is narrow *because naming the command is the security
boundary*. The fabric should inherit that instinct rather than re-open the
question.

**Trust should be explicit, per-machine, and revocable.** Adding a peer is a
deliberate act with a visible moment of consent. Removing one is equally
deliberate and takes effect everywhere, promptly — a revoked machine should
lose its grant even if it is currently offline and comes back later. Trust
should never be transitive: peer A vouching for B must not silently admit B.

**Lifecycle should be owned, not improvised.** If the fabric starts a broker, it
knows that broker is running, can report its health, can restart it, and can
stop it. The failure mode to design out is the orphan: a process the user
started through the fabric and can now only kill by hand. Anything the fabric
can start, it must be able to see and stop.

**Failure should be legible.** "Peer unreachable" is not an answer. The user
needs to know whether the machine is asleep, the credential expired, the
capability was revoked, the process crashed on startup, or the network path is
down — because those have four different remedies. Most distributed-system
frustration is diagnostic poverty, not genuine complexity.

**It should degrade to what already works.** The fabric is an accelerant for
existing paths, never a new dependency. Every machine reachable through it must
remain reachable without it — by direct pairing, by SSH, by hand. If the fabric
is down and the user is locked out of their own machine, it has made things
worse. This also gives an honest migration story: the fabric is a convenience
layer over primitives that keep working.

## What it should not do

The negative space matters as much as the goal.

- **Not a router.** Peers do not relay for one another. If A cannot reach B,
  that is a network problem to fix at the network layer, not to paper over with
  application-level forwarding. Relaying re-introduces the second runtime
  boundary T3's architecture deliberately avoids, and it makes trust transitive
  through the back door.
- **Not a scheduler.** No placement decisions, no "run this wherever is free."
  The user names the machine. Choosing for them requires a model of their
  machines the fabric will not have and should not pretend to.
- **Not a new identity system.** It should ride whatever the user already
  authenticates with. A fresh credential store is a fresh thing to leak, rotate,
  and lose.
- **Not a broadcast medium.** An earlier idea in this project was addressing
  peers by having every machine attempt decryption of every message. That buys
  recipient anonymity — a property with no value among machines one person owns
  — at the cost of O(N) traffic and crypto per message. For a PTY stream it
  would be pathological. Unicast to a named peer is correct.

## Two planes, so no single dependency owns both

Discovery and transport are separate concerns and want separate interfaces.

- **Directory** — who exists, what they will run, whether you are trusted there,
  where they were last reachable.
- **Transport** — how bytes get from here to there.

Keeping them apart is what makes any particular mesh optional. tinc is tempting
precisely because it can fill both slots — mesh transport plus a broadcast
channel to gossip over — and that is also how it becomes a dependency nobody
chose. Behind two interfaces it is one backend among several: Tailscale for
transport where it already exists, mDNS for a directory on a LAN, T3 Connect's
relay where NAT is hostile, tinc where someone wants a self-hosted mesh and no
third party.

Bridging networks then costs nothing conceptually. A peer on the tailnet and a
peer reachable only over a private mesh are two records with different
transports, and nothing above cares which is which as long as a name resolves
to a route.

## Discovery: a hello protocol

Peers announce themselves and answer one question: *who else do you know?* A
client asks a peer, receives its list, and asks the peers on it in turn. No
central registry, and no new transport — the exchange rides whatever route
already reaches each peer.

A peer record carries a stable name, an online hint, and the addresses it was
last reachable on, each tagged with its transport (`tailscale`, `tinc`, `lan`,
`relay`) and ordered by most recent success. Names are the identity; addresses
are cache.

Three properties this must keep, each easy to lose:

**Trust is not transitive.** A peer list is a list of *candidates*, not of
admitted machines. Peer A naming B tells you B exists; admitting B stays a
deliberate act with a visible moment of consent. Gossip that also carries trust
turns one compromised peer into a way to introduce arbitrary machines.

**Status and addresses are hints.** Anything learned second-hand is stale by
construction — a peer's view of a third machine is as old as its last exchange.
Show them as hints, verify on connect, and let the connection be the source of
truth rather than the record.

**An unauthorized caller learns nothing, by default.** Answering "invalid token"
confirms a peer is there and that tokens are the way in; a scanner has found
something worth returning to. The default is that a caller who cannot
authenticate gets a response indistinguishable from nothing being there, and
nothing else — no version, no name, no hint that it guessed the protocol.

How much nothing is a setting, because the postures have different costs:

| Posture | An unauthorized caller sees | Cost |
| --- | --- | --- |
| `diagnostic` | why it was rejected | confirms the peer, names the mechanism |
| `anonymous` *(default)* | a connection that opens and closes | confirms something listens |
| `covert` | nothing; the packet is not answered | needs a transport that allows it |

`anonymous` is the default because it is honest about what a normal TCP service
can achieve. `covert` is the stronger posture and the one with a prerequisite:
by the time a listener has accepted a connection, the handshake has already
answered. Saying nothing therefore has to happen *before* accept, which means
one of

- a transport where the first packet carries authentication and unauthenticated
  packets are dropped without reply. In practice that means **UDP**: TCP cannot
  do it, because the kernel completes the handshake at `listen()` and the
  scanner has its SYN-ACK before the application is consulted. A datagram can
  simply go unanswered, which is why WireGuard does not appear in a port scan.
  UDP suits the rest of this too — NAT traversal is UDP-shaped — and a service
  that never replies before authenticating cannot be turned into a DDoS
  amplifier, which an unauthenticated one can.

  The catch is what silence costs above it: no ordering, no reliability, no
  congestion control, and a handshake to design that resists both forgery and
  CPU exhaustion. Reaching that conclusion is mostly a description of WireGuard,
  so the sane reading is to *run over* an authenticated UDP transport rather
  than write one — which is the same "meshes are interchangeable backends"
  argument arriving again, now for a security property rather than reachability.
- a packet filter in front of the process, opened by prior authorization, or
- not listening at all, which relaying makes possible and which is the only
  option that costs nothing to run.

That last one is worth noticing: `covert` and the no-listener posture are the
same idea reached from two directions, and a peer that only dials out is
already covert without a mode for it.

### First covert implementation: WireGuard

WireGuard is the first transport for `covert`, with others possible later. It
already has the property being asked for — unauthenticated packets are dropped
unanswered — and choosing an existing one avoids designing a handshake, which is
where this would otherwise go wrong.

The bootstrap falls out neatly: **the authenticated channel enrols the covert
one.** Trusted peers exchange WireGuard public keys and endpoints over the
connection they already have, bring up the covert channel, and only then does a
peer changing privacy mode drop its TCP listener. The channel you already trust
builds the channel that replaces it, and no key material ever needs a side
band.

Two rules keep a mode change from being a disconnection:

- **Show the reckoning, then ask.** Before a peer stops listening, the user sees
  which peers the covert channel already reaches and which it does not, and
  decides whether to drop the noisy channel. Verification is the point, but a
  person reading a list is better than a check the software grades itself on —
  and it matches how trust is changed elsewhere here, deliberately and visibly.

  The prompt has to be honest about scope. Dropping the listener is not
  selective: it is not "disconnect these peers" but "stop answering", which
  lands on everyone the covert channel cannot reach. So the useful list is three
  columns, not two — reachable covertly, reachable only by relay through some
  peer that holds both channels, and lost until enrolled. A switch that cannot
  be confirmed rolls back rather than completing, because from the inside,
  "going covert" and "silently disconnecting everyone" look identical.

  Lead with the count, since that is what a person actually decides on: *"12 of
  15 trusted peers stay reachable (80%)."* Three things keep that number from
  flattering itself.

  **Do not fold relay-reachable peers into the headline.** They are reachable
  *while some third peer is up*, which is a dependency, not a property. Count
  them separately — "9 directly, 3 while `sol` is up" — or a peer discovers the
  difference on the day `sol` reboots.

  **A percentage weighs a peer you use hourly the same as one you added months
  ago and forgot.** Name the losses, and order them by how recently they were
  used; 80% is reassuring right up until the missing 20% is the machine running
  your agent.

  **It is a snapshot of what can be verified now.** Status learned second-hand
  is a hint, so the figure should say what it was measured from and when, rather
  than presenting an inference as a fact.

  The same list stays available after the switch, and matters more there. A
  covert peer fails silently by design — nothing answers, which is also what
  working looks like — so a standing view of who is reachable is the only
  feedback left. It should show what is *verified now* rather than what was
  predicted beforehand, and say plainly where the two diverge: a peer that was
  expected to survive and did not is the signal to roll back, and the one thing
  a confirmation dialog dismissed an hour ago can no longer tell anyone.
- **Keep a way back in.** A peer that goes covert and then loses its
  configuration is unreachable by design, and the failure is invisible — no
  port answers, which is exactly what success looks like. It needs a local
  recovery path that does not depend on the fabric: the loopback-only
  diagnostic endpoint above, or a console. Bricked-by-privacy is the failure
  mode this posture invites.

Enrolment before concealment also decides who can ever reach a covert peer: a
peer that is not already enrolled cannot find it, so new peers arrive by
introduction through one that is. That is the relay case again, and it is why
these two features want designing together rather than in sequence.

**Channels are per pair, not per fabric.** Peers need not all share one. Some
reach each other over the noisy channel, some over a covert one, and a peer
holding both is how a message crosses between them. This is the same shape as
the two-plane split: a channel is a route between two peers, and the fabric's
job is to know which routes exist rather than to insist everyone use the same
one. It also means going covert costs less than it first appears — a peer that
loses its direct route may still be reached through one that bridges — and that
the interesting question about any peer is not which mode it is in but which of
its neighbours can still hear it.

Whatever the posture, **sameness has to include timing.** A rejection that is
quick for a malformed token and slow for a well-formed one is an oracle with
extra steps. Compare in constant time and let every failure take the same shape.

Verbose errors are for troubleshooting and troubleshooting is real — silent
failure is miserable to debug, and a mode nobody can debug gets turned off. But
that should not become a switch that trades the property away for everyone.
Diagnostics belong where the caller has already proved something: to
authenticated peers, on a loopback-only endpoint, or in a time-boxed diagnostic
window an operator opens deliberately and which closes itself.

**Records carry no tokens.** A record saying "machine `sol` exists, reachable
here, you hold a grant there" is safe to replicate to every peer. A record
carrying a bearer credential with `terminal:operate` is a shell key on a
broadcast channel, and a gossip layer will diligently copy it everywhere. The
fabric mints a scoped, revocable credential when a connection is made; it never
warehouses one. This is the same rule as "a peer offers capabilities, not
access", applied to the directory.

## Packaging: standalone first, plugin second

It must work with no T3 present, and plug into T3 when wanted. That ordering is
a maintenance decision, not a preference: a tool that depends on T3 inherits the
churn of a fast-moving codebase, and this fork already carries enough of that.

That argues for the shape the ACP bridge already uses in this project — its own
repository, its own tests, no import of T3, and a protocol boundary rather than
a code one:

- **A daemon plus a CLI.** The daemon holds the directory, answers hello, and
  runs on machines with no T3 at all. The CLI is how a person uses it without a
  GUI, which is also how it stays debuggable.
- **A library API for embedding**, so a client can use the directory in-process
  rather than shelling out.
- **A local HTTP or WebSocket API**, which is what T3 should actually talk to.
  Then the daemon runs whether or not T3 does, and the plugin is a thin adapter.

On language: TypeScript on Node keeps the embedding option genuinely available,
since T3 is a pnpm/TypeScript workspace and anything else would force the
protocol route. Two constraints follow, and they matter more than the language
choice:

- **No Effect in the core.** T3 runs an Effect v4 *beta*; taking that dependency
  would tie this tool's maintenance to T3's upgrade schedule, which is the exact
  coupling being avoided. Plain async, with any Effect wrapping done in the T3
  adapter.
- **Few dependencies, and none that assume a host.** The daemon should be
  installable on a small box — the kind of machine most worth reaching remotely
  — and start with nothing configured.

The natural attachment point on the T3 side already exists:
`ConnectionsSettings.tsx` keeps saved remote environments and renders "No saved
remote environments" when empty. A picker fed by the directory belongs there,
and beside the pairing-token field, which is where a user currently transcribes
an address by hand.

## Deferred: peer relaying

Whether peers should carry traffic for each other is **an open question, and a
follow-on design study after the first prototype ships**. It is recorded here
rather than decided because the case for it is stronger than the original
argument against allowed.

The argument against assumed a universal overlay. Where one is partial — which
is the ordinary state of a mixed home network — relaying is not a luxury:

- **A machine that cannot join the overlay.** An old or locked-down box where
  Tailscale will not install is exactly the machine worth reaching remotely. If
  a peer on its LAN can reach both it and you, relaying through that peer is the
  only path.
- **Bridging networks.** A peer joined to a tailnet and to a private mesh *is* a
  relay. Calling those "two records with different transports" describes the
  directory correctly and quietly assumes someone carries bytes across.
- **Policy, not just reachability.** ACLs can permit A↔B and deny you↔B.
- **Discovery already relays.** The hello protocol walks peer lists through
  intermediaries. Relaying knowledge but refusing to relay bytes is a line drawn
  by taste rather than principle.

Relaying also buys a security property that broadcast discovery cannot, and this
may be the stronger argument. A peer introduced *through* peers it already knows
never has to advertise itself: no mDNS announcement, no service published to the
segment, and — if introductions and traffic both travel over connections it
dialled — **no inbound listener at all**. What is not listening cannot be
scanned, port-probed, or reached by a compromised device on the same LAN, and it
traverses NAT without a forwarded port. That is the reverse-worker posture from
option 2 below, arrived at from the other direction.

Two things keep that honest:

- **Somebody still listens.** A peer that accepts relayed connections needs an
  inbound socket, or must itself dial out to a coordination point. The property
  is "most peers need no listener", which concentrates exposure on a few nodes
  rather than removing it. Choosing which nodes those are is the design.
- **Not being findable is not a control.** An introduced peer must still prove
  who it is; obscurity changes the odds of being probed, not the outcome once
  someone is. It also raises what a compromised directory is worth, since the
  directory becomes the only way to find anything.

Two conditions look load-bearing enough to write down now, since they decide
whether relaying stays cheap:

- **End-to-end encrypted, with the relay as a dumb forwarder.** A peer that
  carries traffic must not be able to read it, or every added peer widens what a
  single compromise exposes. This also keeps relaying a transport decision
  rather than a trust one.
- **Relaying is a capability a peer offers.** It spends bandwidth and exposure,
  so it belongs beside "will run a broker": explicitly granted, revocable, and
  used only when no direct route exists.

With both, relaying is a fallback path with an owner rather than the mesh
routing the original argument rejected. Deferring it is a sequencing decision —
the prototype should not carry it — not a judgement that it is unnecessary.

## Implementation options

Three shapes, cheapest first. All satisfy the principles; they differ in what
they assume.

**1. Tailscale-native.** Treat the tailnet as the fabric. Discovery is the
device list, identity is the node key, reachability is solved. A small agent on
each machine advertises its capabilities and starts them on request. T3 already
has the seam: `remote.md` §Endpoint providers exists so contributors can supply
endpoints without touching the core model, and
`apps/desktop/src/backend/tailscaleEndpointProvider.ts` is the worked example.

*Assumes:* everything is on one tailnet. *Gets:* almost all the value for a
fraction of the work, and it composes with what ships today. **This is where I
would start**, and it may be where it ends.

**2. Broker-mediated.** Extend SciREPL-MCP's reverse-worker idea: machines dial
out to a coordination point and receive capability requests. Solves the case
where a machine can reach the network but nothing can reach it, without any
overlay.

*Assumes:* a coordination point exists and is trusted. *Costs:* that point is
now infrastructure to run, and it sees metadata about every machine.

**3. Direct peer links.** Explicit pairwise links, each established once and
remembered — closest to "P2P" in the usual sense, and the most work: NAT
traversal, key management, liveness, all owned rather than borrowed.

*Worth it only if* the fabric must work for machines that will never share an
overlay, which is a requirement worth confirming before paying for it.

## How to know it worked

The honest test is not a feature list. It is: **a user with a new machine can
make it run a broker for them without ever typing an address, and can revoke
that a week later from a phone, and can explain what went wrong when it
fails.** If all three hold, the fabric earned its complexity.

A useful smaller milestone: replace the current manual broker startup for a
single already-tailnetted machine. If it does not clearly beat `ssh box 'start
the broker'` for that case, the larger version will not beat it either.

## Relationship to the rest of this fork

- [mcp-acp-bridge](https://github.com/s243a/mcp-acp-bridge) is what gets *run*.
  The fabric is how it gets started somewhere else.
- [agy-broker-pty.md](./agy-broker-pty.md) — the PTY transport, shelved because
  T3 already covers cross-host connection. The fabric does not revive it; they
  address different layers.
- Command allow/block lists belong to the thing being started, not the fabric.
  A capability grant says *what may run*; the broker's own list says *what that
  thing may then do*. Keeping those separate keeps both comprehensible.
