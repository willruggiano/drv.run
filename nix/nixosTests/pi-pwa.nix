pkgs: let
  # Included by host-basic after it has created the operator's real microVM.
  app = "${pkgs.pi-pwa}/lib/pi-pwa";
  probe = pkgs.writeText "pi-pwa-guest-probe.mjs" ''
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { mkdtemp, rm } from "node:fs/promises";
    import { BACKGROUND_CONTEXT } from "${app}/node_modules/@earendil-works/chord/dist/context/index.js";
    import { createModels } from "${app}/node_modules/@earendil-works/pi-ai/dist/models.js";
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "${app}/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
    import { Sessions, listInstances, remoteInstance } from "${app}/server.js";

    const instance = process.argv[2];
    const runtime = "/run/user/1000";
    const directory = await mkdtemp("/home/operator/pi-pwa-test-");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", {
        command: 'test "$DRV_RUN_TEST_READY" = 1 && printf %s 42 > /workspace/pi-pwa-result.json',
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    const sessions = await Sessions.open({
      directory, models,
      instances: () => listInstances("/home/operator/.local/state", runtime),
      connect: (id) => remoteInstance(id, runtime),
    });
    try {
      const session = await sessions.create(randomUUID(), instance, { provider: "faux", modelId: "faux-1" });
      await session.prompt("Write the guest result.", randomUUID());
      await session.root.waitForIdle(BACKGROUND_CONTEXT);
      assert.equal((await session.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0);
      const results = (await session.history()).flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
      assert.equal(results.length, 1);
      assert.equal(results[0].isError, false);
      assert.equal(faux.state.callCount, 2);
    } finally {
      await sessions.close();
      await rm(directory, { recursive: true });
    }
  '';
in ''
  with subtest("pi serve is owner-scoped and survives its launching shell"):
      operator("PI_OFFLINE=1 pi serve --port 8787")
      host.wait_until_succeeds(as_user("operator", "systemctl --user is-active --quiet pi-pwa.service"))
      host.wait_until_succeeds(as_user("operator", "curl -fsS http://127.0.0.1:8787/api/catalog -o /home/operator/pi-pwa-catalog.json"))
      check = "import json; from pathlib import Path; c=json.loads(Path('/home/operator/pi-pwa-catalog.json').read_text()); "
      check += f"assert any(i['id'] == {instance_id!r} and i['running'] for i in c['instances']); assert c['sessions'] == []"
      operator("python3 -c " + shlex.quote(check))
      operator("systemctl --user stop pi-pwa.service")

  with subtest("host pi-durable executes tools through pi-env in the guest flake environment"):
      operator("${pkgs.nodejs}/bin/node ${probe} " + shlex.quote(instance_id))
      guest("python3 -c " + shlex.quote("import json; from pathlib import Path; assert json.loads(Path('/workspace/pi-pwa-result.json').read_text()) == 42"))
      host.fail("test -e /workspace/pi-pwa-result.json")
''
