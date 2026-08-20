/**
 * AcpAdapter — a provider adapter for any agent that speaks the Agent Client
 * Protocol.
 *
 * Unlike the per-vendor adapters beside it, this one implements *only* what the
 * protocol defines. It sends no `<vendor>/…` methods and answers none: an agent
 * that needs those is describing an extension, which belongs behind the
 * runtime's `handleUnknownExtRequest` seam rather than in here.
 *
 * That constraint is what keeps it general. Everything specific to a particular
 * agent — how to launch it, whether it authenticates, what the client will do on
 * its behalf — arrives as configuration, so supporting a new agent is a settings
 * entry rather than a new file.
 *
 * @module provider/Layers/AcpAdapter
 */
import {
  type AcpSettings,
  EventId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type RuntimeMode,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest, type AcpPermissionRequest } from "../acp/AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

export const ACP_DRIVER_KIND = ProviderDriverKind.make("acp");

const CLIENT_INFO = { name: "t3code", version: "1" } as const;

interface AcpAdapterSessionState {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly scope: Scope.Closeable;
  readonly pumpFiber: Fiber.Fiber<void, never>;
  readonly cwd: string;
  readonly createdAt: string;
  updatedAt: string;
  activeTurnId: TurnId | undefined;
  /**
   * Approvals the agent is blocked on, keyed by the id the client answers with.
   * The agent's `session/request_permission` is a JSON-RPC *request*: its reply
   * is the outcome, so the handler parks here until a person decides.
   */
  readonly pendingApprovals: Map<
    string,
    {
      readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
      readonly permissionRequest: AcpPermissionRequest;
    }
  >;
  model: string | undefined;
  readonly runtimeMode: RuntimeMode;
  status: ProviderSession["status"];
}

export interface AcpAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  /** Overrides the spawn built from settings. Tests use this. */
  readonly spawn?: AcpSessionRuntime.AcpSpawnInput;
}

/**
 * Client capabilities advertised at initialize.
 *
 * These are the consequential settings: saying yes routes the agent's file and
 * command access through this client, where it can be shown and refused; saying
 * no means the agent acts directly and the client never sees it. Both default
 * off in settings, so silence here is a refusal rather than a grant.
 */
/**
 * What this client will actually do for an agent.
 *
 * Deliberately always false, whatever the settings say. Advertising a
 * capability the adapter does not serve is worse than declining it: the agent
 * believes it can ask, and its first `fs/read_text_file` or `terminal/create`
 * comes back as methodNotFound — a failure it cannot plan around, in the middle
 * of work it already started.
 *
 * The equivalent capability is available where it can be reviewed. The bridge
 * offers file and command tools over MCP, so each call is held, shown with its
 * arguments, and approved or refused before it runs — the same treatment as any
 * other tool, rather than the client quietly acting on the agent's say-so.
 */
export function buildAcpClientCapabilities(_settings: AcpSettings) {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  };
}

/** Launch description for the configured agent. */
export function buildAcpSpawnInput(
  settings: AcpSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.command,
    args: [...settings.args],
    cwd,
    env: { ...environment, ...settings.env },
  };
}

export const makeAcpAdapter = Effect.fn("makeAcpAdapter")(function* (
  settings: AcpSettings,
  options?: AcpAdapterOptions,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;

  const sessions = new Map<ThreadId, AcpAdapterSessionState>();
  /** Starts in progress, so a second caller waits rather than spawning again. */
  const starting = new Map<ThreadId, Deferred.Deferred<ProviderSession, ProviderAdapterError>>();
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const nextStamp = Effect.gen(function* () {
    const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* nowIso;
    return { eventId: EventId.make(id), createdAt };
  });

  const requireSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterRequestError({
          provider: ACP_DRIVER_KIND,
          method: "session/lookup",
          detail: `No ACP session for thread ${threadId}.`,
        });
      }
      return session;
    });

  /**
   * Translate one runtime event and publish it.
   *
   * The runtime's event union is already vendor-neutral, so this is a straight
   * mapping — no interpretation, and no invention of events the agent did not
   * send.
   */
  const publishParsedEvent = Effect.fn("AcpAdapter.publishParsedEvent")(function* (
    threadId: ThreadId,
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
  ) {
    if (!("_tag" in event)) return;
    const session = sessions.get(threadId);
    const turnId = session?.activeTurnId;
    const stamp = yield* nextStamp;

    switch (event._tag) {
      case "ContentDelta": {
        yield* PubSub.publish(
          runtimeEvents,
          makeAcpContentDeltaEvent({
            stamp,
            provider: ACP_DRIVER_KIND,
            threadId,
            turnId,
            ...(event.itemId ? { itemId: event.itemId } : {}),
            text: event.text,
            rawPayload: event.rawPayload,
          }),
        );
        return;
      }
      case "ToolCallUpdated": {
        yield* PubSub.publish(
          runtimeEvents,
          makeAcpToolCallEvent({
            stamp,
            provider: ACP_DRIVER_KIND,
            threadId,
            turnId,
            toolCall: event.toolCall,
            rawPayload: event.rawPayload,
          }),
        );
        return;
      }
      case "PlanUpdated": {
        yield* PubSub.publish(
          runtimeEvents,
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: ACP_DRIVER_KIND,
            threadId,
            turnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: event.rawPayload,
          }),
        );
        return;
      }
      case "AssistantItemStarted":
      case "AssistantItemCompleted": {
        yield* PubSub.publish(
          runtimeEvents,
          makeAcpAssistantItemEvent({
            stamp,
            provider: ACP_DRIVER_KIND,
            threadId,
            turnId,
            itemId: event.itemId,
            lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
          }),
        );
        return;
      }
      // Mode changes carry no orchestration meaning for a generic agent; the
      // runtime already tracks the current mode for callers that ask.
      case "ModeChanged":
      default:
        return;
    }
  });

  /** Publish a turn lifecycle event carrying the turn it belongs to. */
  const publishTurnEvent = Effect.fn("AcpAdapter.publishTurnEvent")(function* (
    threadId: ThreadId,
    turnId: TurnId,
    event: { readonly type: "turn.started" | "turn.completed"; readonly payload: unknown },
  ) {
    const stamp = yield* nextStamp;
    yield* PubSub.publish(runtimeEvents, {
      type: event.type,
      ...stamp,
      provider: ACP_DRIVER_KIND,
      threadId,
      turnId,
      payload: event.payload,
    } as ProviderRuntimeEvent);
  });

  /**
   * Close out a turn. Order matters: the terminal event is published while
   * `activeTurnId` is still set, so it carries the turn it ends. Clearing first
   * would emit an orphaned event the client cannot attribute.
   */
  /**
   * A human-readable reason from a failure of any shape.
   *
   * Turn failures reach the client as text, and "[object Object]" tells nobody
   * why their work stopped. Handles defects as well as errors, since a decode
   * failure on an agent's reply arrives as the former.
   */
  function describeCause(cause: unknown): string {
    const failure = Cause.findError(cause as Cause.Cause<unknown>);
    const value = failure ?? Cause.findDefect(cause as Cause.Cause<unknown>) ?? cause;
    if (value instanceof Error) return value.message;
    if (typeof value === "string") return value;
    const described = (value as { message?: unknown })?.message;
    return typeof described === "string" && described.length > 0 ? described : "ACP prompt failed.";
  }

  const endTurn = Effect.fn("AcpAdapter.endTurn")(function* (
    threadId: ThreadId,
    turnId: TurnId,
    payload: {
      readonly state: "completed" | "failed";
      readonly stopReason?: string;
      readonly errorMessage?: string;
    },
  ) {
    yield* publishTurnEvent(threadId, turnId, { type: "turn.completed", payload });
    const session = sessions.get(threadId);
    if (session) {
      // Only the turn holding the slot may release it. A turn cancelled while
      // its successor is already running would otherwise clear the newer id,
      // and every later event would publish with no turn to attribute it to.
      if (session.activeTurnId === turnId) {
        session.activeTurnId = undefined;
        session.status = payload.state === "failed" ? "error" : "ready";
      }
      session.updatedAt = yield* nowIso;
    }
  });

  const openSession = Effect.fn("AcpAdapter.openSession")(function* (
    input: ProviderSessionStartInput,
  ) {
    const cwd = input.cwd ?? process.cwd();
    const scope = yield* Scope.make();

    const runtimeLayer = AcpSessionRuntime.layer({
      spawn: options?.spawn ?? buildAcpSpawnInput(settings, cwd, process.env),
      cwd,
      clientInfo: CLIENT_INFO,
      clientCapabilities: buildAcpClientCapabilities(settings),
      // Omitted entirely when unset, so the runtime skips `authenticate`
      // rather than presenting a method the agent never advertised.
      ...(settings.authMethodId ? { authMethodId: settings.authMethodId } : {}),
    }).pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
    );

    const context = yield* Layer.build(runtimeLayer).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) =>
        mapAcpToAdapterError(ACP_DRIVER_KIND, input.threadId, "session/new", cause),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );

    yield* runtime.start().pipe(
      Effect.mapError((cause) =>
        mapAcpToAdapterError(ACP_DRIVER_KIND, input.threadId, "session/new", cause),
      ),
      // The agent process is already running by now — it spawns during
      // Layer.build, with its kill finalizer in this scope. Failing without
      // closing the scope orphans it, and the retry spawns another.
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );

    // An agent's permission request is a JSON-RPC request whose *reply* is the
    // answer, so the handler blocks until a person decides. Registered before
    // the first turn can run: an unregistered handler answers methodNotFound,
    // which reads to the agent as a client that cannot approve anything.
    yield* runtime.handleRequestPermission((params) =>
      Effect.gen(function* () {
        const state = sessions.get(input.threadId);
        const permissionRequest = parsePermissionRequest(params);
        const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();
        state?.pendingApprovals.set(requestId, { decision, permissionRequest });

        yield* PubSub.publish(
          runtimeEvents,
          makeAcpRequestOpenedEvent({
            stamp: yield* nextStamp,
            provider: ACP_DRIVER_KIND,
            threadId: input.threadId,
            turnId: state?.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            permissionRequest,
            detail: permissionRequest.detail ?? "[no detail]",
            args: params,
            source: "acp.jsonrpc",
            method: "session/request_permission",
            rawPayload: params,
          }),
        );

        const resolved = yield* Deferred.await(decision);
        state?.pendingApprovals.delete(requestId);

        yield* PubSub.publish(
          runtimeEvents,
          makeAcpRequestResolvedEvent({
            stamp: yield* nextStamp,
            provider: ACP_DRIVER_KIND,
            threadId: input.threadId,
            turnId: state?.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            permissionRequest,
            decision: resolved,
          }),
        );

        return {
          outcome:
            resolved === "cancel"
              ? ({ outcome: "cancelled" } as const)
              : { outcome: "selected" as const, optionId: acpPermissionOutcome(resolved) },
        };
      }),
    );

    const pumpFiber = yield* runtime.getEvents().pipe(
      Stream.runForEach((event) => publishParsedEvent(input.threadId, event)),
      Effect.forkDetach,
    );

    const createdAt = yield* nowIso;
    const state: AcpAdapterSessionState = {
      runtime,
      scope,
      pumpFiber,
      cwd,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: undefined,
      pendingApprovals: new Map(),
      model: input.modelSelection?.model,
      runtimeMode: input.runtimeMode,
      status: "ready",
    };
    sessions.set(input.threadId, state);
    return buildSession(input.threadId, state);
  });

  /**
   * Start a session, or join one already starting for this thread.
   *
   * Two concurrent starts would each spawn an agent, and the loser's process
   * and scope would leak with nothing left holding a reference. The claim is
   * settled on every exit — a failed start that left one outstanding would
   * park every later caller on a promise nobody completes.
   */
  const startSession = Effect.fn("AcpAdapter.startSession")(function* (
    input: ProviderSessionStartInput,
  ) {
    const existing = sessions.get(input.threadId);
    if (existing) {
      return buildSession(input.threadId, existing);
    }
    const inFlight = starting.get(input.threadId);
    if (inFlight) {
      return yield* Deferred.await(inFlight);
    }

    const claim = yield* Deferred.make<ProviderSession, ProviderAdapterError>();
    starting.set(input.threadId, claim);
    return yield* openSession(input).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => starting.delete(input.threadId)).pipe(
          Effect.andThen(Deferred.done(claim, exit)),
        ),
      ),
    );
  });

  /**
   * Push the user's option choices to the agent.
   *
   * Best-effort on purpose: an agent that does not implement
   * `session/set_config_option` should still be able to run a turn. Refusing to
   * proceed because a picker could not be applied would make the option worse
   * than not offering it.
   */
  const applyOptionSelections = Effect.fn("AcpAdapter.applyOptionSelections")(function* (
    session: AcpAdapterSessionState,
    selections: ProviderSendTurnInput["modelSelection"],
  ) {
    for (const option of selections?.options ?? []) {
      yield* session.runtime.setConfigOption(option.id, option.value).pipe(Effect.ignore);
    }
    // The model is a selection like any other, and stale until the agent is
    // told. Only on change: agents that re-plan on set_model should not do it
    // every turn.
    const model = selections?.model;
    if (model !== undefined && model !== session.model) {
      yield* session.runtime.setSessionModel(model).pipe(Effect.ignore);
      session.model = model;
    }
  });

  const sendTurn = Effect.fn("AcpAdapter.sendTurn")(function* (input: ProviderSendTurnInput) {
    const session = yield* requireSession(input.threadId);
    yield* applyOptionSelections(session, input.modelSelection);
    const turnUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const turnId = TurnId.make(turnUuid);

    session.activeTurnId = turnId;
    session.status = "running";
    session.updatedAt = yield* nowIso;

    const prompt = [{ type: "text" as const, text: input.input ?? "" }];

    yield* publishTurnEvent(input.threadId, turnId, {
      type: "turn.started",
      payload: {},
    });

    // The prompt resolves when the turn ends; run it detached so callers get a
    // turn id immediately and observe progress through the event stream.
    //
    // Both outcomes MUST publish a terminal event. A turn that fails silently
    // leaves the client showing a spinner for work that already stopped, which
    // is worse than showing the error.
    yield* Effect.forkDetach(
      session.runtime.prompt({ prompt }).pipe(
        // matchCause, not match: a decode failure on the agent's reply arrives
        // as a defect, and a defect would kill this fiber with the turn still
        // marked running — the spinner-forever case.
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            endTurn(input.threadId, turnId, {
              state: "failed",
              errorMessage: describeCause(cause),
            }),
          onSuccess: (response) =>
            endTurn(input.threadId, turnId, {
              state: "completed",
              ...(typeof response?.stopReason === "string"
                ? { stopReason: response.stopReason }
                : {}),
            }),
        }),
      ),
    );

    return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
  });

  const interruptTurn = Effect.fn("AcpAdapter.interruptTurn")(function* (threadId: ThreadId) {
    const session = yield* requireSession(threadId);
    yield* session.runtime.cancel.pipe(
      Effect.mapError((cause) =>
        mapAcpToAdapterError(ACP_DRIVER_KIND, threadId, "session/cancel", cause),
      ),
    );
    session.activeTurnId = undefined;
    session.status = "ready";
  });

  const respondToRequest = Effect.fn("AcpAdapter.respondToRequest")(function* (
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) {
    const session = yield* requireSession(threadId);
    // The answer travels back as the reply to the agent's own request, so this
    // resolves what the handler is parked on. There is no such thing as a
    // client-initiated permission response in ACP.
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: ACP_DRIVER_KIND,
        method: "session/request_permission",
        detail: `Unknown pending approval request: ${requestId}`,
      });
    }
    yield* Deferred.succeed(pending.decision, decision);
  });

  const stopSession = Effect.fn("AcpAdapter.stopSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session) return;
    sessions.delete(threadId);
    yield* Fiber.interrupt(session.pumpFiber);
    yield* Scope.close(session.scope, Exit.void);
  });

  return {
    provider: ACP_DRIVER_KIND,
    capabilities: {
      // Whether an agent can switch model mid-session is a property of that
      // agent, not of this adapter; report the conservative answer rather than
      // promising something the agent may reject.
      sessionModelSwitch: "unsupported",
    },
    startSession,
    sendTurn,
    interruptTurn: (threadId: ThreadId) => interruptTurn(threadId),
    respondToRequest,
    respondToUserInput: (
      threadId: ThreadId,
      _requestId: string,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        // Structured user input has no core-protocol equivalent. Doing nothing
        // is safer than guessing at an extension the agent may not implement.
      }),
    stopSession,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.entries()].map(([threadId, state]) => buildSession(threadId, state)),
      ),
    hasSession: (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId)),
    // ACP has no history-read call. T3 owns the record of a thread, so serving
    // an empty snapshot is honest; fabricating one from the agent would not be.
    readThread: (threadId: ThreadId) =>
      Effect.succeed({ threadId, turns: [] } satisfies ProviderThreadSnapshot),
    rollbackThread: (threadId: ThreadId) =>
      Effect.succeed({ threadId, turns: [] } satisfies ProviderThreadSnapshot),
    stopAll: () =>
      Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
        discard: true,
      }),
    streamEvents: Stream.fromPubSub(runtimeEvents),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});

function buildSession(threadId: ThreadId, state: AcpAdapterSessionState): ProviderSession {
  return {
    provider: ACP_DRIVER_KIND,
    status: state.status,
    runtimeMode: state.runtimeMode,
    cwd: state.cwd,
    threadId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.model ? { model: state.model } : {}),
    ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
  } satisfies ProviderSession;
}
