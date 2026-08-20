import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readModelsFile } from "./AcpDriver.ts";

const CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

/** Write a models file, hand its path to the test, and clean up after. */
const withModelsFile = (
  contents: string,
  use: (path: string) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory().pipe(Effect.orDie);
    const file = path.join(dir, "models.json");
    yield* fs.writeFileString(file, contents).pipe(Effect.orDie);
    return yield* use(file).pipe(
      Effect.ensuring(fs.remove(dir, { recursive: true }).pipe(Effect.orDie)),
    );
  });

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

    it.effect("a profile gets its own list", () =>
      withModelsFile(
        JSON.stringify({
          profiles: { "agy-dual": ["Gemini 3.1 Pro"], claude: ["claude-sonnet-5"] },
          models: ["fallback"],
        }),
        (file) =>
          Effect.gen(function* () {
            const dual = yield* readModelsFile(file, CAPABILITIES, "agy-dual");
            expect(dual.map((model) => model.slug)).toEqual(["Gemini 3.1 Pro"]);

            const claude = yield* readModelsFile(file, CAPABILITIES, "claude");
            expect(claude.map((model) => model.slug)).toEqual(["claude-sonnet-5"]);
          }),
      ),
    );

    it.effect("an unprofiled or unlisted agent falls back to the shared list", () =>
      withModelsFile(
        JSON.stringify({ profiles: { "agy-dual": ["Gemini 3.1 Pro"] }, models: ["fallback"] }),
        (file) =>
          Effect.gen(function* () {
            expect((yield* readModelsFile(file, CAPABILITIES)).map((m) => m.slug)).toEqual([
              "fallback",
            ]);
            expect(
              (yield* readModelsFile(file, CAPABILITIES, "not-in-the-file")).map((m) => m.slug),
            ).toEqual(["fallback"]);
          }),
      ),
    );

    it.effect("a profile may spell its list the long way", () =>
      withModelsFile(
        JSON.stringify({
          profiles: { "agy-dual": { models: [{ id: "pro", name: "Gemini 3.1 Pro" }] } },
        }),
        (file) =>
          Effect.gen(function* () {
            const models = yield* readModelsFile(file, CAPABILITIES, "agy-dual");
            expect(models.map((model) => [model.slug, model.name])).toEqual([
              ["pro", "Gemini 3.1 Pro"],
            ]);
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
