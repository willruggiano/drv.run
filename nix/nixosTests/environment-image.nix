{pkgs}: let
  inherit (pkgs) lib;
  mkImage = import ../mkEnvironmentImage.nix {inherit pkgs;};
  dependency = pkgs.writeShellScriptBin "image-fixture" ''
    printf '%s\n' present > "$1"
  '';
  link = pkgs.runCommand "image-fixture-link" {} ''
    ln -s ${dependency}/bin/image-fixture "$out"
  '';
  danglingLink = pkgs.runCommand "image-fixture-dangling-link" {} ''
    ln -s $'/missing\n' "$out"
  '';
  # The prepared-environment interface, not a second flake evaluation. Include
  # a regular-file store root (E), directory root and top-level symlink root.
  environment = pkgs.writeText "image-fixture-env" (builtins.toJSON {
    variables = {
      PATH = {
        type = "exported";
        value = lib.makeBinPath [dependency];
      };
      fixtureLink = {
        type = "exported";
        value = toString link;
      };
      danglingLink = {
        type = "exported";
        value = toString danglingLink;
      };
      outputs = {
        type = "array";
        value = [];
      };
    };
    bashFunctions = {};
  });
  image = mkImage {inherit environment;};
  imageClosure = pkgs.closureInfo {rootPaths = [image environment];};
  metadataTests = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../tests/environment-metadata.test.ts
      ../tests/provision.test.ts
      ../../nixosModules/guest/environment-metadata.jq
      ../../nixosModules/guest/guest.sh
      ../../nixosModules/host/post.sh
      ../../nixosModules/timing.sh
    ];
  };
  # Exercise the real preparation/lifecycle worker without a nested hypervisor.
  # Only its runner and image-factory boundaries are fixtures; Nix realization,
  # profiles, GC roots, state/seed disks and systemd cleanup are real.
  runner = pkgs.writeShellScriptBin "microvm-run" "exit 0";
  imageExpression = pkgs.writeText "fixture-image-expression.nix" ''
    { environment }:
    assert builtins.storePath environment == builtins.storePath "${environment}";
    builtins.derivation {
      name = "fixture-environment-image";
      system = "${pkgs.stdenv.hostPlatform.system}";
      builder = builtins.storePath "${pkgs.bash}" + "/bin/bash";
      args = [ "-c" (
        builtins.storePath "${pkgs.coreutils}" + "/bin/ln -s " +
        builtins.storePath "${image}" + " $out"
      ) ];
    }
  '';
  worker = pkgs.writeShellApplication {
    name = "image-worker";
    runtimeInputs = [pkgs.nixVersions.nix_2_35 pkgs.coreutils pkgs.jq pkgs.e2fsprogs pkgs.openssh];
    text =
      lib.replaceStrings
      ["@runner@" "@image-expression@" "@proxy@" "@create-volumes@" "@mitm-proxy-seed@" "@timing@"]
      [
        (toString runner)
        (toString imageExpression)
        "${pkgs.systemd}/lib/systemd/systemd-ssh-proxy"
        ''
          truncate -s 32M state.img
          mke2fs -q -t ext4 -L drv-run-state state.img
        ''
        ""
        (builtins.readFile ../../nixosModules/timing.sh)
      ]
      (builtins.readFile ../../nixosModules/host/pre.sh);
  };
  rebuilt = image.overrideAttrs {name = "drv-run-environment-image-rebuilt";};
  changed = mkImage {environment = pkgs.writeText "different-env" "{}";};
  builderChanged = image.overrideAttrs (old: {buildPhase = old.buildPhase + "\n";});
  seed = pkgs.runCommand "environment-image-test-seed" {nativeBuildInputs = [pkgs.e2fsprogs];} ''
    mkdir seed
    printf '%s\n' ${environment} > seed/environment
    truncate -s 8M "$out"
    mke2fs -q -t ext4 -L drv-run-seed -d seed "$out"
    e2fsck -fn "$out"
  '';
in {
  artifact = assert image.drvPath == (mkImage {inherit environment;}).drvPath;
  assert image.drvPath != changed.drvPath;
  assert image.drvPath != builderChanged.drvPath;
    pkgs.runCommand "environment-image-check" {
      nativeBuildInputs = [pkgs.erofs-utils pkgs.nixVersions.nix_2_35 pkgs.jq pkgs.nodejs];
    } ''
      export NIX_CONFIG=$'experimental-features = nix-command flakes\nbuild-users-group ='
      export HOME="$TMPDIR/home"
      mkdir -p "$HOME"
      node --test "${metadataTests}/nix/tests/*.test.ts"
      # A different derivation forces an independent build of the same bytes.
      cmp ${image}/store.erofs ${rebuilt}/store.erofs
      fsck.erofs --extract=extracted ${image}/store.erofs
      cmp extracted/environment <(printf '%s\n' ${environment})
      test -L extracted/store/${builtins.baseNameOf link}
      test -x extracted/store/${builtins.baseNameOf dependency}/bin/image-fixture
      jq -r 'keys[]' extracted/path-info.json > paths
      while IFS= read -r path; do
        nix hash path --format sri "extracted/store/''${path##*/}" > actual
        jq -r --arg path "$path" '.[$path].narHash' extracted/path-info.json > expected
        cmp actual expected
      done < paths

      # Private local stores: exercise real Nix roots, signed substitution and
      # concurrent image requests without touching the builder's store database.
      sourceStore="local?root=$PWD/source"
      destinationStore="local?root=$PWD/destination"
      mkdir -p source/nix/store
      while IFS= read -r path; do
        cp -a "$path" source/nix/store/
      done < ${imageClosure}/store-paths
      nix-store --store "$sourceStore" --load-db < ${imageClosure}/registration
      nix key generate-secret --key-name environment-image-test > secret
      nix key convert-secret-to-public < secret > public
      nix store sign --store "$sourceStore" --key-file secret --recursive ${image} ${environment}
      nix copy --from "$sourceStore" --to "file://$PWD/cache" ${image} ${environment}
      # Initialize SQLite before racing realizations, not database creation.
      nix-store --store "$destinationStore" --init
      mkdir first second
      pids=()
      for instance in first second; do
        (
          nix-store --store "$destinationStore" --realise ${image} \
            --option substituters "file://$PWD/cache" \
            --option trusted-public-keys "$(< public)" \
            --add-root "$PWD/$instance/image"
          nix-store --store "$destinationStore" --realise ${environment} \
            --option substituters "file://$PWD/cache" \
            --option trusted-public-keys "$(< public)" \
            --add-root "$PWD/$instance/environment"
        ) &
        pids+=("$!")
      done
      for pid in "''${pids[@]}"; do wait "$pid"; done
      cmp ${image}/store.erofs destination${image}/store.erofs
      nix-store --store "$destinationStore" --gc
      nix-store --store "$destinationStore" --check-validity ${image} ${environment}
      rm -r first
      nix-store --store "$destinationStore" --gc
      nix-store --store "$destinationStore" --check-validity ${image} ${environment}
      test -L second/image
      test -L second/environment
      rm -r second
      touch "$out"
    '';

  integration = pkgs.testers.runNixOSTest {
    name = "environment-image";
    # The test framework otherwise copies every testScript store reference into
    # each generic disk, which would conceal a missing environment image layer.
    includeTestScriptReferences = false;
    defaults = {
      config,
      lib,
      ...
    }: {
      imports = [
        ../../nixosModules/nix.nix
        # qemu-vm overrides fileSystems with virtualisation.fileSystems. Adapt
        # only that option namespace, keeping the production mounts and service.
        (args @ {
          config,
          lib,
          pkgs,
          ...
        }: let
          module = import ../../nixosModules/guest/environment.nix args;
        in
          builtins.removeAttrs module ["fileSystems"]
          // {virtualisation.fileSystems = module.fileSystems;})
      ];
      boot.initrd.systemd.enable = true;
      virtualisation = {
        memorySize = 768;
        cores = 2;
        graphics = false;
        useNixStoreImage = true;
        mountHostNixStore = false;
        writableStore = true;
        writableStoreUseTmpfs = false;
        qemu.options = [
          "-drive file=${image}/store.erofs,format=raw,if=virtio,readonly=on"
          "-drive file=${seed},format=raw,if=virtio,readonly=on"
        ];
      };
      virtualisation.fileSystems."/run/drv-run-seed" = {
        device = "/dev/disk/by-label/drv-run-seed";
        fsType = "ext4";
        options = ["ro"];
        neededForBoot = true;
        noCheck = true;
      };
      # The test driver uses a unit instead of microvm's stage-2 registration.
      systemd.services.drv-run-environment = {
        after = ["register-nix-paths.service"];
        requires = ["register-nix-paths.service"];
      };
      # Re-run the actual initializer without stopping sysinit.target or powering
      # down the backdoor on intentionally invalid input. The production service
      # continues to own the runtime directory.
      systemd.services.environment-probe.serviceConfig = {
        Type = "oneshot";
        ExecStart = config.systemd.services.drv-run-environment.serviceConfig.ExecStart;
      };
      # This job is queued during first boot, not just after provisioning.
      systemd.services.nix-gc.wantedBy = ["multi-user.target"];
      environment.systemPackages = [pkgs.python3 pkgs.jq pkgs.sqlite];
      nix.settings = {
        experimental-features = ["nix-command" "flakes"];
        substituters = lib.mkForce [];
        flake-registry = "";
      };
    };
    nodes = {
      first = {};
      second = {
        systemd.services."image-worker@".serviceConfig = {
          StateDirectory = "image-worker/%i";
          RuntimeDirectory = "drv.run.%i";
          ExecStartPre = lib.getExe worker;
          ExecStart = "${pkgs.coreutils}/bin/sleep infinity";
          KillMode = "control-group";
        };
      };
    };
    testScript = ''
      import json
      import shlex

      environment = "${environment}"
      dependency = "${dependency}"
      link = "${link}"
      profile = "/nix/var/nix/profiles/project"
      ready = "/run/drv-run-environment/ready"
      production_unit = "drv-run-environment.service"
      unit = "environment-probe.service"
      upper = "/nix/.rw-store/upper"

      start_all()
      for machine in [first, second]:
          machine.wait_for_unit("multi-user.target")
          machine.wait_for_unit(production_unit)
          machine.succeed(f"test {profile} -ef {environment}; test -f {ready}")
          phases = machine.succeed("cat /run/drv-run-environment/timings.jsonl").splitlines()
          timestamps = [json.loads(phase)["monotonic_s"] for phase in phases]
          assert timestamps == sorted(timestamps)
          # The fixture must come from the extra disk, not the generic image.
          if machine is first:
              machine.fail(f"test -e /nix/.ro-store/{dependency.rsplit('/', 1)[1]}")
          machine.succeed(f"{link} /root/executed")
          machine.succeed("test -s /root/executed")
          machine.fail(f"test -e {upper}/{dependency.rsplit('/', 1)[1]}")
          machine.succeed(f"nix-store --check-validity {environment} {dependency} {link}")
          info = json.loads(machine.succeed(f"nix path-info --json --json-format 1 {environment}"))
          assert dependency in info[environment]["references"]
          assert link in info[environment]["references"]
          mount = json.loads(machine.succeed("findmnt --json --mountpoint /nix/.environment"))["filesystems"][0]
          assert mount["fstype"] == "erofs"
          assert "ro" in mount["options"].split(",")
          assert int(machine.succeed("blockdev --getro /dev/disk/by-label/drv-run-env")) == 1
          machine.fail("touch /nix/.environment/modified")
          machine.succeed(f"test ! -e {profile}-2-link")
          initialized = int(machine.succeed(f"systemctl show {production_unit} -p ActiveEnterTimestampMonotonic --value"))
          gc_started = int(machine.succeed("systemctl show nix-gc.service -p ExecMainStartTimestampMonotonic --value"))
          assert 0 < initialized <= gc_started

      with subtest("private writable state, builds and GC"):
          first.succeed("mkdir -p /workspace; touch /workspace/retained")
          second.fail("test -e /workspace/retained")
          expression = 'derivation { name = "writable-fixture"; system = "${pkgs.stdenv.hostPlatform.system}"; builder = builtins.storePath "${pkgs.bash}" + "/bin/bash"; args = [ "-c" (builtins.storePath "${link}" + " $out") ]; }'
          first.succeed("nix-build --expr " + shlex.quote(expression) + " --out-link /root/built")
          first.succeed(f'test -e {upper}/$(basename "$(readlink -e /root/built)")')
          first.succeed("nix-store --gc")
          first.succeed(f"{link} /root/after-gc; test {profile} -ef {environment}")
          second.fail("test -e /root/after-gc || test -e /root/built")

      with subtest("restart preserves E, workspace and profile generation"):
          first.shutdown()
          first.start()
          first.wait_for_unit(production_unit)
          first.succeed(f"test -f /workspace/retained; test {profile} -ef {environment}; test ! -e {profile}-2-link")
          first.succeed(f"{link} /root/after-restart")

      def restart_failure():
          first.fail(f"systemctl start {unit}")
          first.succeed(f"systemctl is-failed --quiet {unit}")
          first.fail(f"test -e {ready}")

      def restore():
          first.succeed(f"systemctl reset-failed {unit}; systemctl start {unit}")
          first.succeed(f"test {profile} -ef {environment}; test -f {ready}")

      with subtest("mismatched host expectation fails closed"):
          first.succeed(f"systemctl stop {unit}; printf '%s\\n' /nix/store/wrong-env > /root/wrong")
          first.succeed("mount --bind /root/wrong /run/drv-run-seed/environment")
          restart_failure()
          first.succeed("umount /run/drv-run-seed/environment")
          restore()

      with subtest("conflicting overlap fails before registration changes the database"):
          first.succeed(f"systemctl stop {unit}")
          original = json.loads(first.succeed(f"nix path-info --json --json-format 1 {dependency}"))[dependency]
          first.succeed("sqlite3 /nix/var/nix/db/db.sqlite " + shlex.quote(
              f"UPDATE ValidPaths SET narSize = narSize + 1 WHERE path = '{dependency}'"))
          restart_failure()
          changed = json.loads(first.succeed(f"nix path-info --json --json-format 1 {dependency}"))[dependency]
          assert changed["narSize"] == original["narSize"] + 1
          first.succeed("sqlite3 /nix/var/nix/db/db.sqlite " + shlex.quote(
              f"UPDATE ValidPaths SET narSize = {original['narSize']} WHERE path = '{dependency}'"))
          restore()

      with subtest("missing environment mount fails closed"):
          first.succeed("mkdir /root/empty-image; mount --bind /root/empty-image /nix/.environment")
          restart_failure()
          first.succeed("umount /nix/.environment")
          restore()

      with subtest("invalid registration fails without publishing readiness"):
          first.succeed(f"systemctl stop {unit}; printf 'not-a-store-path\\n' > /root/invalid-registration")
          first.succeed("mount --bind /root/invalid-registration /nix/.environment/registration")
          restart_failure()
          first.succeed("umount /nix/.environment/registration")
          restore()
          second.succeed(f"{link} /root/peer-still-usable")

      # No VMM is launched by these worker-only units. A regular test device
      # satisfies the access precondition even when nested KVM is unavailable.
      second.succeed("test -e /dev/kvm || touch /dev/kvm")

      def prepare_instance(name, reference=environment):
          second.succeed(f"mkdir -p /run/drv.run.{name}; printf '%s\\n' {shlex.quote(reference)} > /run/drv.run.{name}/reference")

      with subtest("two prepared instances retain shared artifacts with independent state"):
          for name in ["alpha", "beta"]:
              prepare_instance(name)
              second.succeed(f"systemctl start image-worker@{name}.service")
              state = f"/var/lib/image-worker/{name}"
              second.succeed(f"test -d {state}/ready; test {state}/environment -ef {environment}; test {state}/environment-image -ef ${image}")
              second.succeed(f"test /run/drv.run.{name}/environment.erofs -ef ${image}/store.erofs")
          second.succeed("test ! /var/lib/image-worker/alpha/state.img -ef /var/lib/image-worker/beta/state.img")
          second.succeed("systemctl stop image-worker@alpha.service; nix-store --gc")
          second.succeed("cp /var/lib/image-worker/alpha/state.img /root/saved-state.img")
          second.succeed("printf '%s\\n' path:/does-not-exist > /var/lib/image-worker/alpha/reference")
          second.succeed("systemctl start image-worker@alpha.service")
          second.succeed("cmp /var/lib/image-worker/alpha/state.img /root/saved-state.img")
          second.succeed("systemctl stop image-worker@alpha.service; systemctl clean --what=state image-worker@alpha.service")
          second.fail("test -e /var/lib/image-worker/alpha")
          second.succeed("nix-store --gc; test -f /var/lib/image-worker/beta/environment-image/store.erofs")

      with subtest("restart never recreates missing established resources"):
          second.succeed("systemctl stop image-worker@beta.service")
          for resource in ["state.img", "environment-image"]:
              state = "/var/lib/image-worker/beta"
              second.succeed(f"mv {state}/{resource} {state}/saved")
              second.fail("systemctl start image-worker@beta.service")
              second.fail(f"test -e {state}/{resource} || test -e /run/drv.run.beta/client.conf")
              second.succeed(f"mv {state}/saved {state}/{resource}; systemctl reset-failed image-worker@beta.service")
          second.succeed("systemctl start image-worker@beta.service; systemctl stop image-worker@beta.service")

      with subtest("interrupted creation requires explicit cleanup"):
          prepare_instance("interrupted")
          second.succeed("mkdir -p /var/lib/image-worker/interrupted/creating; touch /var/lib/image-worker/interrupted/state.img")
          second.fail("systemctl start image-worker@interrupted.service")
          second.succeed("test ! -s /var/lib/image-worker/interrupted/state.img; test -d /var/lib/image-worker/interrupted/creating")
          second.fail("test -e /var/lib/image-worker/interrupted/ready || test -e /run/drv.run.interrupted/client.conf")

      with subtest("failed image realization cannot mark resources prepared"):
          second.succeed(f"cp {environment} /root/mismatch-env; nix-store --add /root/mismatch-env > /root/mismatch-path")
          mismatched = second.succeed("cat /root/mismatch-path").strip()
          prepare_instance("failed", mismatched)
          second.fail("systemctl start image-worker@failed.service")
          second.succeed("test -d /var/lib/image-worker/failed/creating")
          second.fail("test -e /var/lib/image-worker/failed/ready || test -e /run/drv.run.failed/client.conf")
    '';
  };
}
