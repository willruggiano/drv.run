{pkgs}: {environment}: let
  # Keep Nix responsible for traversal and the registration wire format. The
  # additional JSON is only for comparing immutable-layer metadata in the guest.
  closure = (pkgs.closureInfo {rootPaths = [environment];}).overrideAttrs (old: {
    nativeBuildInputs = old.nativeBuildInputs ++ [pkgs.nixVersions.nix_2_35 pkgs.findutils];
    buildCommand =
      old.buildCommand
      + ''
        jq -r '.closure[].narHash' "$NIX_ATTRS_JSON_FILE" |
          xargs -r nix-hash --type sha256 --to-base64 > hashes
        jq --rawfile hashes hashes '
          ($hashes | split("\n") | map(select(length > 0))) as $hashes |
          .closure | to_entries | map({
            key: .value.path,
            value: {
              narHash: ("sha256-" + $hashes[.key]),
              narSize: .value.narSize,
              references: (.value.references | sort)
            }
          }) | from_entries
        ' "$NIX_ATTRS_JSON_FILE" > "$out/path-info.json"
      '';
  });
in
  pkgs.stdenvNoCC.mkDerivation {
    name = "drv-run-environment-image";
    inherit environment;
    nativeBuildInputs = with pkgs; [bubblewrap erofs-utils util-linux];
    dontUnpack = true;
    dontInstall = true;
    dontFixup = true;
    doCheck = true;
    # Unlike microvm.storeDisk, this artifact is substitutable.
    allowSubstitutes = true;
    buildPhase = ''
      runHook preBuild
      mkdir -p "$out" root/store
      cp ${closure}/registration root/registration
      cp ${closure}/path-info.json root/path-info.json
      printf '%s\n' "$environment" > root/environment
      chmod 0444 root/{registration,path-info.json,environment}

      # No full-closure staging copy, including when user namespaces are disabled
      # on a builder. Such a builder must fail rather than change the algorithm.
      mounts=(--ro-bind / / --bind "$TMPDIR" "$TMPDIR" --bind "$out" "$out")
      while IFS= read -r path; do
        destination="$PWD/root/store/''${path##*/}"
        if test -L "$path"; then
          # A bind mount would dereference a top-level store symlink. Copy only
          # its link metadata (also preserving targets with trailing newlines).
          cp --no-dereference "$path" "$destination"
        else
          if test -d "$path"; then
            mkdir "$destination"
          else
            touch "$destination"
          fi
          mounts+=(--ro-bind "$path" "$destination")
        fi
      done < ${closure}/store-paths
      chmod 0555 root root/store
      # Fix UUID, block size, time, ownership, compression and worker count.
      # Hardlinks in the host store depend on optimisation history, not E.
      bwrap --unshare-user --die-with-parent "''${mounts[@]}" --chdir "$PWD" \
        mkfs.erofs -b4096 -zlz4 --workers=1 -T1 --all-root -x-1 \
          --hard-dereference -U00000000-0000-0000-0000-000000000001 \
          -L drv-run-env "$out/store.erofs" root
      runHook postBuild
    '';
    checkPhase = ''
      runHook preCheck
      test "$(blkid -p -s TYPE -o value "$out/store.erofs")" = erofs
      test "$(blkid -p -s LABEL -o value "$out/store.erofs")" = drv-run-env
      # --extract without a directory validates every encoded extent without
      # copying the closure back out. Kernel mountability is covered by the VM.
      fsck.erofs --extract "$out/store.erofs"
      runHook postCheck
    '';
  }
