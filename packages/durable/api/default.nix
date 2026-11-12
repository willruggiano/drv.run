{
  importNpmLock,
  lib,
  nodejs,
  stdenvNoCC,
  typescript,
}: let
  pkg = lib.importJSON ./package.json;
in
  stdenvNoCC.mkDerivation {
    pname = pkg.name;
    inherit (pkg) version;
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [
        ./.gitignore
        ./.npmrc
        ./package.json
        ./package-lock.json
        ./tsconfig.json
        ./tsconfig.build.json
        ./graphql/tsconfig.grats.json
        ./graphql/graphql.ts
        ./graphql/graphql.test.ts
        ./src
        ./tests
      ];
    };
    npmDeps = importNpmLock {npmRoot = ./.;};
    npmRebuildFlags = ["--ignore-scripts"];
    nativeBuildInputs = [
      importNpmLock.npmConfigHook
      nodejs
      typescript
    ];
    preBuild = ''
      patch --batch --forward --fuzz=0 \
        -d node_modules/@earendil-works/pi-durable -p1 \
        < ${../pi-durable-conversation-context.patch}
    '';
    buildPhase = ''
      runHook preBuild
      npm run build
      runHook postBuild
    '';
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      npm run check
      npm test
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      consumer="$TMPDIR/consumer"
      mkdir -p "$consumer/node_modules"
      cp -R node_modules/graphql "$consumer/node_modules/"
      npm prune --omit=dev --omit=peer --ignore-scripts --offline
      test ! -e node_modules/graphql
      mkdir -p "$out/lib/${pkg.name}"
      cp -R package.json dist node_modules "$out/lib/${pkg.name}/"
      install -Dm644 graphql/schema.graphql "$out/lib/${pkg.name}/graphql/schema.graphql"
      cp -R "$out/lib/${pkg.name}" "$consumer/node_modules/${pkg.name}"
      cp -R "$consumer/node_modules/${pkg.name}/node_modules/." "$consumer/node_modules/"
      rm -r "$consumer/node_modules/${pkg.name}/node_modules"
      cat > "$consumer/tsconfig.json" <<JSON
      {
        "extends": "$PWD/tsconfig.json",
        "compilerOptions": { "customConditions": [] },
        "include": ["consumer.mts"]
      }
      JSON
      cat > "$consumer/consumer.mts" <<'JS'
      import assert from "node:assert/strict";
      import { once } from "node:events";
      import { readFile } from "node:fs/promises";
      import { createServer } from "node:http";
      import { createRequire } from "node:module";
      import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
      import { createModels } from "@earendil-works/pi-ai/models";
      import {
        GraphQLError, GraphQLSchema, buildSchema, graphql,
        introspectionFromSchema, lexicographicSortSchema, validateSchema,
      } from "graphql";
      import { createApi } from "durable-api";
      import { createSchema, type ResolverContext } from "durable-api/graphql";
      import { createTelemetry } from "durable-api/telemetry";

      const require = createRequire(import.meta.url);
      const apiRequire = createRequire(import.meta.resolve("durable-api/graphql"));
      assert.equal(require.resolve("graphql"), apiRequire.resolve("graphql"));
      for (const dependency of ["grats", "typescript", "knip", "c8"]) {
        assert.throws(() => apiRequire.resolve(dependency), { code: "MODULE_NOT_FOUND" });
      }
      assert.equal(typeof createTelemetry, "function");
      const models = createModels();
      const schema: GraphQLSchema = createSchema();
      assert(schema instanceof GraphQLSchema);
      assert.deepEqual(validateSchema(schema), []);
      const sdl = await readFile(
        new URL(import.meta.resolve("durable-api/graphql/schema.graphql")), "utf8",
      );
      assert.deepEqual(
        introspectionFromSchema(lexicographicSortSchema(schema)),
        introspectionFromSchema(lexicographicSortSchema(buildSchema(sdl))),
      );
      const context: ResolverContext = {
        context: BACKGROUND_CONTEXT,
        session: async () => undefined,
        sessions: async () => [],
        models: () => models,
      };
      const result = await graphql({
        schema,
        source: '{ harness(externalId: "absent") { id } harnesses { id } models { id } }',
        contextValue: context,
      });
      assert.equal(result.errors, undefined);
      assert.deepEqual({ ...result.data }, { harness: null, harnesses: [], models: [] });
      const invalid = await graphql({
        schema,
        source: '{ node(id: "invalid") { id } }',
        contextValue: context,
      });
      assert.equal(invalid.data?.node, null);
      assert.equal(invalid.errors?.length, 1);
      assert(invalid.errors[0] instanceof GraphQLError);
      assert.equal(invalid.errors[0].extensions.code, "BAD_REQUEST");

      const api = createApi({
        models,
        async openHarness() { assert.fail("catalog must not open a Harness"); },
      });
      const server = createServer(api.handle);
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert(address && typeof address !== "string");
        const response = await fetch(`http://127.0.0.1:''${address.port}/api/models`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), []);
      } finally {
        await api.close();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      JS
      tsc -p "$consumer/tsconfig.json"
      node "$consumer/consumer.mts"
      runHook postInstall
    '';
  }
