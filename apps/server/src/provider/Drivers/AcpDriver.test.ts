import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

import { readModelsFile } from "./AcpDriver.ts";

const CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

const withModelsFile = <A>(contents: string, use: (path: string) => Effect.Effect<A>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-models-"));
      const file = NodePath.join(dir, "models.json");
      await NodeFSP.writeFile(file, contents, "utf8");
      return { dir, file };
    }),
    ({ file }) => use(file),
    ({ dir }) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );

it.layer(NodeServices.layer)("AcpDriver", (it) => {
  describe("models file", () => {
    it.effect("keeps the agent's own name rather than a slug of it", () =>
      withModelsFile(
        JSON.stringify({ models: [{ id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" }] }),
        (file) =>
          Effect.gen(function* () {
            const models = yield* readModelsFile(file, CAPABILITIES);
            expect(models).toEqual([
              {
                slug: "gemini-3.7-flash",
                name: "Gemini 3.7 Flash",
                isCustom: false,
                capabilities: CAPABILITIES,
              },
            ]);
          }),
      ),
    );

    it.effect("accepts a bare list of ids, naming each after itself", () =>
      withModelsFile(JSON.stringify(["fast", "slow"]), (file) =>
        Effect.gen(function* () {
          const models = yield* readModelsFile(file, CAPABILITIES);
          expect(models.map((model) => [model.slug, model.name])).toEqual([
            ["fast", "fast"],
            ["slow", "slow"],
          ]);
        }),
      ),
    );

    it.effect("drops entries with no usable id, and duplicates", () =>
      withModelsFile(
        JSON.stringify({ models: [{ id: "a" }, { name: "no id" }, "", { id: "a" }, "b"] }),
        (file) =>
          Effect.gen(function* () {
            const models = yield* readModelsFile(file, CAPABILITIES);
            expect(models.map((model) => model.slug)).toEqual(["a", "b"]);
          }),
      ),
    );

    it.effect("an unreadable file costs the model list, not the provider", () =>
      Effect.gen(function* () {
        expect(yield* readModelsFile("/nonexistent/models.json", CAPABILITIES)).toEqual([]);
      }),
    );

    it.effect("malformed JSON is treated the same way", () =>
      withModelsFile("{ not json", (file) =>
        Effect.gen(function* () {
          expect(yield* readModelsFile(file, CAPABILITIES)).toEqual([]);
        }),
      ),
    );

    it.effect("no configured path means no file to read", () =>
      Effect.gen(function* () {
        expect(yield* readModelsFile("", CAPABILITIES)).toEqual([]);
      }),
    );
  });
});
