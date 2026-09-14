---
name: nix-store-gc
description: >
  Diagnose and reclaim Nix store space when builds fail with No space left on
  device.
---

# Need more space? Give this a read

Symptom:

```text
microvm-store-disk.erofs> failed to write: No space left on device
error: build failure may have been caused by lack of free disk space
```

Diagnosis (is /nix/store the culprit?):

```bash
df -h / /nix/store /workspace
nix-store --gc --print-dead |
  tr '\n' '\0' |
  du --files0-from=- --summarize --total --human-readable |
  sort -hr |
  head -n 16
du -sh /nix/var/nix/builds/*
```

Resolution (if /nix/store _is_ the culprit):

```bash
nix store gc
```
