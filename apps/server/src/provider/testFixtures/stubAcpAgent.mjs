#!/usr/bin/env node
/**
 * Minimal ACP agent for adapter tests.
 *
 * Answers the startup handshake, then behaves according to argv[2]:
 *   ok   — a prompt streams one assistant chunk and succeeds
 *   fail — the agent exits mid-prompt, leaving the request outstanding
 *
 * Exists so turn outcomes can be tested without a real agent, network, or
 * credentials.
 */
const mode = process.argv[2] === "fail" ? "fail" : "ok";

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

function handle(message) {
  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      });
    case "authenticate":
      return reply(message.id, {});
    case "session/new":
      return reply(message.id, {
        sessionId: "stub-session",
        models: {
          currentModelId: "stub",
          availableModels: [{ modelId: "stub", name: "Stub" }],
        },
      });
    case "session/prompt": {
      if (mode === "fail") {
        // Die mid-turn. A JSON-RPC error reply is the politer failure, but this
        // is the one a client must survive: the agent goes away with the
        // request outstanding.
        process.stderr.write("stub agent dying mid-prompt\n");
        return process.exit(1);
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "stub-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from stub" },
          },
        },
      });
      return reply(message.id, { stopReason: "end_turn" });
    }
    default:
      if (message.id !== undefined) reply(message.id, {});
  }
}
