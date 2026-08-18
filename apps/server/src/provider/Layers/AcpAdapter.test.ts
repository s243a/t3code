/**
 * Turn lifecycle for the generic ACP adapter, driven against a stub agent.
 *
 * The property under test is that every turn reaches a terminal event carrying
 * its own turn id. A turn that ends without one leaves the client showing
 * progress for work that already stopped.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AcpSettings, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeAcpAdapter } from "./AcpAdapter.ts";

const decodeAcpSettings = Schema.decodeSync(AcpSettings);
const STUB = new URL("../testFixtures/stubAcpAgent.mjs", import.meta.url).pathname;

const settingsFor = (mode: "ok" | "fail") =>
  decodeAcpSettings({
    enabled: true,
    command: process.execPath,
    args: [STUB, mode],
  });

/** Run a turn and collect the runtime events it produces. */
const runTurn = Effect.fn("runTurn")(function* (mode: "ok" | "fail") {
  const adapter = yield* makeAcpAdapter(settingsFor(mode));
  const threadId = ThreadId.make("acp-adapter-turn-test");

  const collected: Array<{ type: string; turnId?: string; payload?: unknown }> = [];
  const collector = yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        collected.push({
          type: event.type,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...("payload" in event ? { payload: event.payload } : {}),
        });
      }),
    ),
    Effect.forkDetach,
  );

  yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
  const started = yield* adapter.sendTurn({ threadId, input: "hello" });

  // Bounded wait on a real subprocess. TestClock.adjust keeps the fiber's own
  // timers moving while yieldNow hands the event loop back so process IO can
  // land; it exits as soon as the terminal event arrives.
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (collected.some((event) => event.type === "turn.completed")) break;
    yield* TestClock.adjust("10 millis");
    yield* Effect.yieldNow;
  }

  yield* adapter.stopSession(threadId);
  yield* Fiber.interrupt(collector);
  return { collected, turnId: started.turnId };
});

describe("AcpAdapter", () => {
  it.layer(NodeServices.layer)("turn lifecycle", (it) => {
    it.effect(
      "a successful turn completes and the event carries its turn id",
      () =>
        Effect.gen(function* () {
          const { collected, turnId } = yield* runTurn("ok");

          const completed = collected.find((event) => event.type === "turn.completed");
          assert.isDefined(completed, "expected a terminal turn event");
          assert.strictEqual(completed?.turnId, turnId, "terminal event must name its turn");
          assert.strictEqual(
            (completed?.payload as { state?: string } | undefined)?.state,
            "completed",
          );
          assert.isTrue(
            collected.some((event) => event.type === "turn.started"),
            "expected a turn.started event",
          );
        }),
      { timeout: 60_000 },
    );

    // KNOWN GAP: an agent that replies to `session/prompt` with a JSON-RPC
    // *error* rather than dying leaves the request unsettled — the turn emits
    // `turn.started` and nothing else. Agent death is covered below; the polite
    // refusal is not, and needs a fix in the runtime's request correlation.
    it.effect(
      "a failing turn still reports a terminal event instead of hanging",
      () =>
        Effect.gen(function* () {
          const { collected, turnId } = yield* runTurn("fail");

          const completed = collected.find((event) => event.type === "turn.completed");
          assert.isDefined(completed, "a failed turn must still terminate");
          assert.strictEqual(completed?.turnId, turnId);
          const payload = completed?.payload as
            | { state?: string; errorMessage?: string }
            | undefined;
          assert.strictEqual(payload?.state, "failed");
          assert.isTrue((payload?.errorMessage ?? "").length > 0, "a failure must explain itself");
        }),
      { timeout: 60_000 },
    );
  });
});
