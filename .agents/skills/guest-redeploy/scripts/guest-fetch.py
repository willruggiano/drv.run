#!/usr/bin/env python3
"""Fetch a guest's committed tip without changing either checkout or its bookmarks."""

import argparse
import json
import re
import shlex
import subprocess
import sys
import uuid
from pathlib import Path

SSH = ["ssh", "-T", "-F", "examples/rock5b/.ssh/config", "rock5b"]
EXPORT = r"""
set -euo pipefail
cd -- "$1"
source=$2 ref=$3 marker=$4 candidate=$5
if [[ -e .jj ]]; then
    source=${source:-@-}
    resolve() { jj --ignore-working-copy log -r "$source" --no-graph -T 'commit_id ++ "\n"'; }
    tip=$(resolve)
    [[ $tip =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || { echo 'Source must resolve to one commit' >&2; exit 1; }
    # Even an explicitly selected source must not include this workspace's working copy.
    working_copy=$(jj --ignore-working-copy log -r "@ & ancestors($tip)" --no-graph -T commit_id)
    [[ -z $working_copy ]] || {
        echo 'Refusing to export the working-copy commit' >&2; exit 1;
    }
    gitdir=$(jj --ignore-working-copy git root)
else
    [[ -n $source ]] || source=HEAD
    resolve() { git rev-parse --verify "$source^{commit}"; }
    tip=$(resolve)
    gitdir=$(git rev-parse --absolute-git-dir)
fi
git() { command git --git-dir="$gitdir" "$@"; }
base=
if [[ -n $candidate ]] && git merge-base --is-ancestor "$candidate" "$tip" 2>/dev/null; then
    base=$candidate
fi
[[ $(resolve) == "$tip" ]] || { echo 'Guest source changed; retry' >&2; exit 1; }
# A unique ref makes even an unbookmarked commit exportable. Never move a guest bookmark.
git update-ref "$ref" "$tip" "${tip//?/0}"
trap 'git update-ref -d "$ref" "$tip"' EXIT
printf '\n%s\n%s\n%s\n' "$marker" "$tip" "$base"
if [[ $base == "$tip" ]]; then
    exit 0
elif [[ -n $base ]]; then
    git bundle create - "$ref" "^$base"
else
    git bundle create - "$ref"
fi
"""


def run(*args: str, **kwargs) -> bytes:
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, **kwargs).stdout


def discover(output: str) -> str:
    instances = re.findall(
        r"^me (drv\.run\.[A-Za-z0-9]+) .*: running$", output, re.MULTILINE
    )
    if len(instances) != 1:
        raise ValueError(
            f"Expected one running guest, found {instances}; use --instance"
        )
    return instances[0]


def guest_command(instance: str, args: list[str]) -> str:
    return shlex.join(
        ["su", "--login", "me", "--command", shlex.join(["ssh", "-T", instance, *args])]
    )


def unpack(data: bytes, marker: str) -> tuple[str, str, bytes]:
    prefix, separator, payload = data.partition(f"\n{marker}\n".encode())
    if not separator:
        raise ValueError("Guest did not emit the bundle marker")
    if prefix:
        print(prefix.decode(errors="replace"), file=sys.stderr)
    tip, base, bundle = payload.split(b"\n", 2)
    oid = rb"(?:[0-9a-f]{40}|[0-9a-f]{64})"
    if not re.fullmatch(oid, tip) or (base and not re.fullmatch(oid, base)):
        raise ValueError("Invalid commit ID in guest response")
    if tip != base and not bundle.startswith(
        (b"# v2 git bundle\n", b"# v3 git bundle\n")
    ):
        raise ValueError("Invalid bundle header")
    return tip.decode(), base.decode(), bundle


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--instance", help="Guest name (default: discover the only running guest)"
    )
    parser.add_argument("--workspace", default="/workspace/drv.run")
    parser.add_argument(
        "--source", help="Guest revset/ref (default: @- for jj, HEAD for Git)"
    )
    parser.add_argument(
        "--base", help="Known imported ancestor; defaults to local @- as a hint"
    )
    args = parser.parse_args()
    if not Path("examples/rock5b/.ssh/config").is_file() or not Path(".jj").exists():
        parser.error("Run from the local drv.run Jujutsu repository root")
    instance = args.instance or discover(run(*SSH, "drv.run list -u me").decode())
    if not re.fullmatch(r"drv\.run\.[A-Za-z0-9]+", instance):
        parser.error("--instance must look like drv.run.ID")
    candidate = (
        run(
            "jj",
            "log",
            "-r",
            args.base or "@-",
            "--no-graph",
            "-T",
            'commit_id ++ "\\n"',
        )
        .decode()
        .strip()
    )
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", candidate):
        parser.error("Local base must resolve to exactly one commit; use --base")
    token = uuid.uuid4().hex
    ref = f"refs/heads/instance-recovery/{instance}-{token}"
    marker = f"GUEST_BUNDLE_{token}"
    # The small shell script travels over stdin; every command layer is quoted once.
    command = guest_command(
        instance,
        [
            shlex.join(
                [
                    "bash",
                    "-s",
                    "--",
                    args.workspace,
                    args.source or "",
                    ref,
                    marker,
                    candidate,
                ]
            )
        ],
    )
    tip, base, bundle = unpack(run(*SSH, command, input=EXPORT.encode()), marker)
    if tip == base:
        print(f"Already imported: {tip}")
        return
    scratch = Path(".scratch")
    scratch.mkdir(exist_ok=True)
    path = scratch / f"{instance}-{token}.bundle"
    path.write_bytes(bundle)
    gitdir = run("jj", "git", "root").decode().strip()
    run("git", f"--git-dir={gitdir}", "bundle", "verify", str(path.resolve()))
    run(
        "git",
        f"--git-dir={gitdir}",
        "fetch",
        "--no-tags",
        str(path.resolve()),
        f"{ref}:{ref}",
    )
    receipt = {"tip": tip, "base": base or None, "recovery": ref, "bundle": str(path)}
    path.with_suffix(".json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    print("Fetched only; local checkout and destination bookmarks were not moved.")
    print(f"Inspect: jj log -r 'ancestors({tip}, 10)'")
    print(f"After verification, remove recovery ref: git update-ref -d {ref} {tip}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
