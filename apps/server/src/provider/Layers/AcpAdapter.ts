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
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
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
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
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
export function buildAcpClientCapabilities(settings: AcpSettings) {
  return {
    fs: {
      readTextFile: settings.filesystemAccess,
      writeTextFile: settings.filesystemAccess,
    },
    terminal: settings.terminalAccess,
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

  const startSession = Effect.fn("AcpAdapter.startSession")(function* (
    input: ProviderSessionStartInput,
  ) {
    const existing = sessions.get(input.threadId);
    if (existing) {
      return buildSession(input.threadId, existing);
    }

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

    yield* runtime
      .start()
      .pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(ACP_DRIVER_KIND, input.threadId, "session/new", cause),
        ),
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
      model: input.modelSelection?.model,
      runtimeMode: input.runtimeMode,
      status: "ready",
    };
    sessions.set(input.threadId, state);
    return buildSession(input.threadId, state);
  });

  const sendTurn = Effect.fn("AcpAdapter.sendTurn")(function* (input: ProviderSendTurnInput) {
    const session = yield* requireSession(input.threadId);
    const turnUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const turnId = TurnId.make(turnUuid);

    session.activeTurnId = turnId;
    session.status = "running";
    session.updatedAt = yield* nowIso;

    const prompt = [{ type: "text" as const, text: input.input ?? "" }];

    // The prompt resolves when the turn ends; run it detached so callers get a
    // turn id immediately and observe progress through the event stream.
    yield* Effect.forkDetach(
      session.runtime.prompt({ prompt }).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() => {
              session.activeTurnId = undefined;
              session.status = "error";
            }),
          onSuccess: () =>
            Effect.sync(() => {
              session.activeTurnId = undefined;
              session.status = "ready";
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
    yield* session.runtime
      .request("session/request_permission/response", {
        requestId,
        outcome: { outcome: "selected", optionId: acpPermissionOutcome(decision) },
      })
      .pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(ACP_DRIVER_KIND, threadId, "session/request_permission", cause),
        ),
        Effect.asVoid,
      );
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
