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
      node --test graphql/graphql.test.ts
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --omit=peer --ignore-scripts --offline
      mkdir -p "$out/lib/${pkg.name}"
      cp -R package.json dist node_modules "$out/lib/${pkg.name}/"
      install -Dm644 graphql/schema.graphql "$out/lib/${pkg.name}/graphql/schema.graphql"
      (
        cd "$out/lib/${pkg.name}"
        node --input-type=module <<'JS'
      import assert from "node:assert/strict";
      import { once } from "node:events";
      import { createServer } from "node:http";
      import { createModels } from "@earendil-works/pi-ai/models";
      import { createApi } from "durable-api";

      const api = createApi({
        models: createModels(),
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
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      JS
      )
      runHook postInstall
    '';
  }
