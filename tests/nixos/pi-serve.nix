{
  nixosModules,
  pkgs,
  testers,
  pi-serve,
  pi-drv-run,
}: let
  # Nix's path fetcher reuses registered store paths only when named "source".
  nixpkgs = builtins.path {
    name = "source";
    path = pkgs.path;
  };
  shell = pkgs.mkShell {
    packages = [pkgs.python3];
    shellHook = "export DRV_RUN_TEST_READY=1";
  };
  fixture = pkgs.writeText "flake.nix" ''
    {
      inputs.nixpkgs.url = "path:${nixpkgs}";
      outputs = { nixpkgs, ... }: {
        devShells.${pkgs.stdenv.hostPlatform.system}.default =
          let pkgs = nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system}; in pkgs.mkShell {
            packages = [pkgs.python3];
            shellHook = "export DRV_RUN_TEST_READY=1";
          };
      };
    }
  '';
  app = "${pi-serve}/lib/pi-serve";
  probe = pkgs.writeText "pi-serve-guest-probe.mjs" ''
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { access, constants, mkdtemp, realpath, rm } from "node:fs/promises";
    import { BACKGROUND_CONTEXT } from "${app}/node_modules/@earendil-works/chord/dist/context/index.js";
    import { createModels } from "${app}/node_modules/@earendil-works/pi-ai/dist/models.js";
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "${app}/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
    import { history, inspectContext } from "${app}/../pi-runtime/index.js";
    import { openApplication } from "${app}/application.js";
    import { ownerOptions } from "${pi-drv-run}/lib/pi-extensions/drv-run/index.js";
    import { localDaemon } from "${app}/node_modules/@earendil-works/pi-env/dist/index.js";

    // Installed consumers share the production workspace, not the test tree.
    const modules = await realpath("${app}/node_modules");
    assert.equal(await realpath("${app}/../pi-runtime/node_modules"), modules);
    assert.equal(await realpath("${pi-drv-run}/lib/pi-extensions/drv-run/node_modules"), modules);
    await access(localDaemon(), constants.X_OK);
    await assert.rejects(access(modules + "/playwright"), { code: "ENOENT" });

    const instance = process.argv[2];
    const untrusted = process.argv[3] === "untrusted";
    const directory = await mkdtemp("/home/operator/pi-serve-test-");
    const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(untrusted ? [
      fauxAssistantMessage(fauxToolCall("bash", {
        command: "touch /workspace/untrusted-key-ran",
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Failed."),
    ] : [
      ({ messages }) => {
        const section = messages.filter(message => message.role === "system" && message.sections?.context).at(-1);
        const prepared = JSON.parse(section.sections.context);
        assert.deepEqual(prepared.files.map(file => [file.level, file.path]), [
          ["system", "/etc/xdg/llms.txt"],
          ["user", "/root/.config/llms.txt"],
          ["repo", "/workspace/README.md"],
        ]);
        assert.equal(prepared.contributing, false);
        return fauxAssistantMessage(fauxToolCall("write", { path: "pi-serve-result.json", content: "41" }), { stopReason: "toolUse" });
      },
      ({ messages }) => {
        const section = messages.filter(message => message.role === "system" && message.sections?.context).at(-1);
        const prepared = JSON.parse(section.sections.context);
        assert.deepEqual(prepared.files.at(-1), {
          level: "repo", path: "/workspace/CONTRIBUTING.md", content: "Use structured edits.",
        });
        assert.equal(prepared.contributing, true);
        return fauxAssistantMessage(fauxToolCall("write", { path: "pi-serve-result.json", content: "41" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("edit", { path: "pi-serve-result.json", oldText: "41", newText: "42" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "pi-serve-result.json" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", {
        command: 'test "$DRV_RUN_TEST_READY" = 1 && test "$(pwd)" = /workspace && test -f pi-serve-result.json',
      }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("codemode", { code: `
        await tools.write({ path: "pi-codemode-result.json", content: "1" });
        await tools.edit({ path: "pi-codemode-result.json", edits: [{ oldText: "1", newText: "2" }] });
        await tools.read({ path: "pi-codemode-result.json" });
        await tools.bash({ command: 'test "$DRV_RUN_TEST_READY" = 1 && test "$(pwd)" = /workspace && test -f pi-codemode-result.json' });
      ` }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done."),
    ]);
    const sessions = await openApplication({
      directory, models, cwd: "/workspace", local: false, drvRun: ownerOptions(),
    });
    try {
      const session = await sessions.create(randomUUID(), {
        provider: "drv.run", target: instance, cwd: "/workspace",
      }, { provider: "faux", modelId: "faux-1" });
      await session.root.submit({ type: "input", content: "Write the guest result.", requestId: randomUUID() }, BACKGROUND_CONTEXT);
      await session.root.waitForIdle(BACKGROUND_CONTEXT);
      assert.equal((await session.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0);
      const results = (await history(session)).flatMap((entry) => entry.model ?? []).filter((message) => message.role === "toolResult");
      // A rejected host identity cannot execute commands or fall back to the host.
      assert.equal(results.length, untrusted ? 1 : 6);
      if (!untrusted) {
        assert.equal(results[0].isError, true);
        assert(results.slice(1).every((result) => !result.isError));
        assert.equal(results.at(-1).toolName, "codemode");
        assert.deepEqual(results.at(-1).details.calls.map((call) => [call.name, call.status]), [
          ["write", "ok"], ["edit", "ok"], ["read", "ok"], ["bash", "ok"],
        ]);
      }
      const watch = await session.root.watch(BACKGROUND_CONTEXT);
      try {
        const inspection = await inspectContext(session, watch.value);
        assert.equal(inspection.state, "available");
        assert.equal(inspection.conversation, session.root.id);
        assert.equal(inspection.tokens, inspection.messages.reduce((sum, message) => sum + message.tokens, 0));
        if (!untrusted) {
          assert(inspection.messages.some(message => message.parts.some(part => part.name === "sections.context" && part.children?.some(file => file.name === "/workspace/README.md"))));
        }
      } finally {
        await watch.stop();
      }
      assert.equal(faux.state.callCount, untrusted ? 2 : 7);
    } finally {
      await sessions.close();
      await rm(directory, { recursive: true });
    }
  '';
in
  testers.runNixOSTest {
    name = "pi-serve";
    imports = [./common.nix];
    # Exercise the public module without the drv.run overlay.
    node.pkgs = pkgs.lib.mkForce (import pkgs.path {inherit (pkgs.stdenv.hostPlatform) system;});
    nodes.client.environment.systemPackages = [pkgs.curl];
    nodes.host = {
      imports = [nixosModules.host nixosModules.pi];
      services.pi = {
        enable = true;
        user = "operator";
        port = 8787;
        package = pkgs.writeShellScriptBin "pi-serve" ''
          exec ${pkgs.lib.getExe pi-serve} --no-local \
            --drv-run "$@"
        '';
      };
      systemd.user.services.pi.environment.PI_OFFLINE = "1";
      networking.firewall.interfaces.eth1.allowedTCPPorts = [8787];
      services.drv-run.network = {
        uplink = "eth1";
        dnsServers = ["192.168.1.1"];
      };
      environment.systemPackages = [pkgs.curl pkgs.python3];
      virtualisation.additionalPaths = [shell nixpkgs];
      users.users.operator = {
        isNormalUser = true;
        uid = 1000;
        group = "operator";
      };
      users.groups.operator.gid = 1000;
      users.users.observer = {
        isNormalUser = true;
        uid = 1001;
        group = "observer";
      };
      users.groups.observer.gid = 1001;
      nix = {
        enable = true;
        settings = {
          experimental-features = ["nix-command" "flakes"];
          sandbox = true;
          substituters = pkgs.lib.mkForce [];
        };
      };
    };
    nodes.standalone = {
      imports = [nixosModules.pi];
      services.pi = {
        enable = true;
        user = "operator";
        port = 8787;
      };
      users.users.operator = {
        isNormalUser = true;
        uid = 1000;
      };
      systemd.user.services.pi.environment.PI_OFFLINE = "1";
      environment.systemPackages = [pkgs.curl];
    };
    testScript = ''
      from datetime import timedelta
      import json
      import shlex

      def as_user(user: str, command: str):
          return "su --login " + shlex.quote(user) + " --command " + shlex.quote(command)

      def operator(command: str):
          return host.succeed(as_user("operator",
              "export XDG_RUNTIME_DIR=/run/user/1000; " + command
          ), timeout=timedelta(minutes=15))

      def guest(command: str):
          return operator("ssh -T " + shlex.quote(target) + " " + shlex.quote(command))

      with subtest("standalone web frontend starts without drv.run and offers local execution"):
          standalone.wait_for_unit("user@1000.service")
          standalone.wait_until_succeeds("test -S /run/user/1000/bus")
          standalone.wait_for_unit("pi.service", user="operator")
          standalone.wait_until_succeeds("curl -fsS http://127.0.0.1:8787/api/catalog -o /tmp/catalog.json")
          catalog = json.loads(standalone.succeed("cat /tmp/catalog.json"))
          t.assertEqual(catalog["targets"], [{
              "provider": "local", "target": "/home/operator", "cwd": "/home/operator",
              "label": "Local · /home/operator", "available": True,
          }])
          t.assertEqual(catalog["sessions"], [])
          standalone.fail("test -e /home/operator/.local/state/drv.run")
          standalone.shutdown()

      host.wait_for_unit("default.target")
      host.wait_for_unit("systemd-networkd.service")
      host.wait_for_unit("user@1000.service")
      host.wait_until_succeeds("test -S /run/user/1000/bus")
      host.wait_for_unit("default.target", user="operator")

      with subtest("declarative user service starts at boot only for its configured owner"):
          host.wait_for_unit("pi.service", user="operator")
          host.wait_for_unit("default.target", user="observer")
          host.succeed("test -f /etc/systemd/user/pi.service")
          host.fail(as_user("observer", "XDG_RUNTIME_DIR=/run/user/1001 systemctl --user is-active --quiet pi.service"))
          host.succeed(as_user("observer", "XDG_RUNTIME_DIR=/run/user/1001 systemctl --user start pi.service"))
          host.fail(as_user("observer", "XDG_RUNTIME_DIR=/run/user/1001 systemctl --user is-active --quiet pi.service"))
          host.wait_until_succeeds("curl -fsS http://127.0.0.1:8787/api/catalog")
          addresses = json.loads(host.succeed("ip -4 -j address show dev eth1"))[0]["addr_info"]
          lan_ip = next(address["local"] for address in addresses if address["scope"] == "global")
          client.wait_until_succeeds(f"curl -fsS http://{lan_ip}:8787/api/catalog")
          host.succeed("test ! -e ${pi-serve}/bin/pi")

      with subtest("create a real guest with an offline flake environment"):
          operator("mkdir /home/operator/flake")
          operator("cp ${fixture} /home/operator/flake/flake.nix")
          operator("nix flake lock --offline path:/home/operator/flake")
          operator("SSH_ORIGINAL_COMMAND='path:/home/operator/flake true' drv.run </dev/null")
          instances = operator("find /home/operator/.local/state/drv.run -mindepth 1 -maxdepth 1 -type d").splitlines()
          t.assertEqual(len(instances), 1)
          instance_id = instances[0].rsplit("/", 1)[1]
          target = "drv.run." + instance_id
          operator(f"systemctl --user is-active --quiet drv.run@{instance_id}.service")
          guest('test "$DRV_RUN_TEST_READY" = 1')

      with subtest("user service sees its owner instances and supports stop and restart"):
          host.wait_until_succeeds(as_user("operator", "curl -fsS http://127.0.0.1:8787/api/catalog -o /home/operator/pi-serve-catalog.json"))
          catalog = json.loads(operator("cat /home/operator/pi-serve-catalog.json"))
          t.assertTrue(any(target["provider"] == "drv.run" and target["target"] == instance_id and target["available"] for target in catalog["targets"]))
          t.assertFalse(any(target["provider"] == "local" for target in catalog["targets"]))
          t.assertEqual(catalog["sessions"], [])
          pid = int(operator("systemctl --user show -p MainPID --value pi.service"))
          t.assertEqual(int(host.succeed(f"stat -c %u /proc/{pid}")), 1000)
          host.succeed("python3 -c " + shlex.quote(
              f"from pathlib import Path; assert b'PI_OFFLINE=1' in Path('/proc/{pid}/environ').read_bytes().split(bytes([0]))"
          ))
          operator("systemctl --user restart pi.service")
          host.wait_until_succeeds("curl -fsS http://127.0.0.1:8787/api/catalog")
          restarted_pid = int(operator("systemctl --user show -p MainPID --value pi.service"))
          t.assertNotEqual(pid, restarted_pid)
          t.assertEqual(int(host.succeed(f"stat -c %u /proc/{restarted_pid}")), 1000)
          operator("systemctl --user stop pi.service")
          host.fail(as_user("operator", "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active --quiet pi.service"))
          client.fail(f"curl -fsS http://{lan_ip}:8787/api/catalog")
          operator("systemctl --user start pi.service")
          client.wait_until_succeeds(f"curl -fsS http://{lan_ip}:8787/api/catalog")
          operator("systemctl --user stop pi.service")

      with subtest("host pi-durable loads context and gates mutations in the guest flake environment"):
          guest("test -r /etc/xdg/llms.txt")
          guest("python3 -c " + shlex.quote(
              "from pathlib import Path; "
              "Path('/root/.config').mkdir(exist_ok=True); "
              "Path('/root/.config/llms.txt').write_text('Guest user instructions.'); "
              "Path('/workspace/README.md').write_text('Guest project.'); "
              "Path('/workspace/CONTRIBUTING.md').write_text('Use structured edits.')"
          ))
          operator("${pkgs.nodejs}/bin/node ${probe} " + shlex.quote(instance_id))
          guest("python3 -c " + shlex.quote("import json; from pathlib import Path; assert json.loads(Path('/workspace/pi-serve-result.json').read_text()) == 42"))
          host.fail("test -e /workspace/pi-serve-result.json")

      with subtest("untrusted guest host key cannot execute tools or fall back to local execution"):
          known_hosts = f"/run/user/1000/drv.run.{instance_id}/known_hosts"
          operator(f"cp {known_hosts} {known_hosts}.saved")
          operator(f"truncate -s 0 {known_hosts}")
          operator("${pkgs.nodejs}/bin/node ${probe} " + shlex.quote(instance_id) + " untrusted")
          operator(f"mv {known_hosts}.saved {known_hosts}")
          guest("test ! -e /workspace/untrusted-key-ran")
          host.fail("test -e /workspace/untrusted-key-ran")

      host.succeed("drv.run stop -u operator --all")
    '';
  }
