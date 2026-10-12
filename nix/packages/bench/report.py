"""Run the installed benchmark over SSH and regenerate the Time to Shell table."""

import argparse
import datetime
import json
import re
import shlex
import subprocess
import tarfile
import tempfile
from pathlib import Path
from typing import cast

from . import benchmark as b

START = "<!-- time-to-shell:start -->"
END = "<!-- time-to-shell:end -->"


def validate(output: Path) -> dict[str, b.Json]:
    manifest = b.read_json(output / "manifest.json")
    summary = b.read_json(output / "summary.json")
    b.require(manifest["runs"] == 1, "expected exactly one measured run")
    b.require(
        summary["complete"] is True and summary["error"] is None, "incomplete run"
    )
    b.require(not (output / "pending.json").exists(), "cleanup is pending")
    samples: list[dict[str, b.Json]] = []
    evidence: dict[str, b.Json] = {}
    for batch in ("warmup", "measured"):
        joined = b.load_batch(output, batch, 1)
        trial = output / batch / "trials" / "0000"
        unit = b.read_json(trial / "unit.json")
        service = b.read_json(trial / "service.json")
        sample = joined[0]
        b.require(
            sample["outcome"] == sample["cleanup"] == "success"
            and sample["launcher_exit_code"] == 0,
            f"{batch} failed",
        )
        timing = b.timings(unit, service, b.text(sample["unit"]))
        for field in b.METRICS:
            b.require(sample[field] == timing[field], f"inconsistent {field}")
        samples.extend(joined)
        evidence[batch] = {
            "unit": unit,
            "service": service,
            "phase": b.read_json(trial / "phase.json"),
            "hyperfine": b.read_json(output / batch / "hyperfine.json"),
        }
    b.require(
        b.summarize(samples)
        == {
            key: value
            for key, value in summary.items()
            if key not in ("complete", "error")
        },
        "summary disagrees with raw evidence",
    )
    recorded = [
        json.loads(line) for line in (output / "samples.jsonl").read_text().splitlines()
    ]
    b.require(recorded == samples, "samples disagree with raw evidence")
    return {
        "manifest": manifest,
        "summary": summary,
        "samples": cast(b.Json, samples),
        "evidence": evidence,
    }


def render(records: list[dict[str, b.Json]]) -> str:
    lines = [
        START,
        "",
        "| Configuration | Nix | Runs | Shell (s) | Worker (s) | Boot wait (s) | Provision (s) | Manager gaps (s) |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    reference: b.Json = None
    for record in records:
        manifest = b.obj(record["manifest"])
        if reference is None:
            reference = manifest["reference"]
        b.require(
            reference == manifest["reference"], "cannot compare different workloads"
        )
        summary = b.obj(record["summary"])
        metrics = b.obj(summary["metrics"])
        values = [
            f"{float(cast(float, b.obj(metrics[key])['median'])):.3f}"
            for key in (
                "launcher_s",
                "worker_s",
                "boot_wait_s",
                "provision_s",
                "manager_gaps_s",
            )
        ]
        label = b.text(record["label"])
        version = b.text(b.obj(manifest["versions"])["nix"])
        b.require(not any(c in label + version for c in "|\n\r"), "invalid table cell")
        lines.append(f"| {label} | {version} | 1 | " + " | ".join(values) + " |")
    return "\n".join([*lines, "", END])


def update_document(path: Path, table: str) -> None:
    document = path.read_text()
    if START in document or END in document:
        b.require(
            document.count(START) == document.count(END) == 1, "invalid table markers"
        )
        before, rest = document.split(START)
        _, after = rest.split(END)
        document = before + table + after
    else:
        b.require(
            "## Time to Shell" not in document, "section exists without table markers"
        )
        document += "\n## Time to Shell\n\n" + table + "\n"
    b.atomic_text(path, document)


class Arguments(argparse.Namespace):
    label: str = ""
    host: str = "rock5b"
    ssh_config: str = "examples/rock5b/.ssh/config"
    owner: str = "pi"
    reference: str = ""
    results: Path = Path("docs/benchmarks")
    document: Path = Path("docs/benchmarks.md")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument("label", help="unique result name, e.g. baseline")
    _ = parser.add_argument("--host", default="rock5b")
    _ = parser.add_argument("--ssh-config", default="examples/rock5b/.ssh/config")
    _ = parser.add_argument("--owner", default="pi")
    _ = parser.add_argument("--reference", required=True, type=b.reference)
    _ = parser.add_argument("--results", type=Path, default=Path("docs/benchmarks"))
    _ = parser.add_argument("--document", type=Path, default=Path("docs/benchmarks.md"))
    args = parser.parse_args(namespace=Arguments())
    label = str(args.label)
    b.require(re.fullmatch(r"[a-z0-9][a-z0-9-]*", label) is not None, "invalid label")
    results = args.results
    results.mkdir(parents=True, exist_ok=True)
    destination = results / f"{label}.json"
    b.require(not destination.exists(), "result already exists; choose a new label")
    ssh = ["ssh", "-F", str(args.ssh_config), str(args.host)]
    stamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%SZ")
    remote = f"/home/{args.owner}/benchmarks/time-to-shell-{label}-{stamp}"
    command = shlex.join(
        [
            "/run/current-system/sw/bin/bench",
            "--reference",
            str(args.reference),
            "--runs",
            "1",
            "--output",
            remote,
        ]
    )
    # SSH transport and all evidence collection are outside the measured interval.
    completed = subprocess.run(
        [*ssh, shlex.join(["runuser", "-l", str(args.owner), "-c", command])],
        check=False,
    )
    b.require(
        completed.returncode == 0, f"benchmark failed; evidence retained at {remote}"
    )
    with tempfile.TemporaryDirectory(prefix="time-to-shell-") as temporary:
        directory = Path(temporary)
        with (directory / "raw.tar").open("wb") as archive:
            _ = subprocess.run(
                [*ssh, shlex.join(["tar", "-C", remote, "-cf", "-", "."])],
                stdout=archive,
                check=True,
            )
        with tarfile.open(directory / "raw.tar") as archive:
            archive.extractall(directory / "raw", filter="data")
        record = validate(directory / "raw")
    record.update(label=label, date_utc=stamp, remote_output=remote)
    # Record the system Nix separately: older bench wrappers embed pkgs.nix.
    record["host_nix"] = subprocess.check_output(
        [*ssh, "/run/current-system/sw/bin/nix --version"], text=True
    ).strip()
    record["host_config"] = subprocess.check_output(
        [*ssh, "/run/current-system/sw/bin/nix config show --json"], text=True
    ).strip()
    records = [b.read_json(path) for path in results.glob("*.json")]
    records.append(record)
    records.sort(key=lambda item: b.text(item["date_utc"]))
    table = render(records)
    b.save(destination, record)
    update_document(args.document, table)
    print(f"Recorded {destination}; full evidence: {args.host}:{remote}")


if __name__ == "__main__":
    main()
