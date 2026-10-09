import argparse
import fcntl
import json
import math
import os
import platform
import re
import shlex
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
from collections.abc import Callable, Generator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import cast

type Json = None | bool | int | float | str | list["Json"] | dict[str, "Json"]
type Command = Callable[[list[str]], str]
UNIT = re.compile(r"drv\.run@([A-Za-z0-9]+)\.service")
METRICS = (
    "activation_us",
    "worker_us",
    "boot_wait_us",
    "provision_us",
    "manager_gaps_us",
)
BUS = "org.freedesktop.systemd1"
BUS_PATH = "/org/freedesktop/systemd1"


class BenchmarkError(Exception):
    pass


class ActivationError(BenchmarkError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BenchmarkError(message)


def obj(value: Json) -> dict[str, Json]:
    require(isinstance(value, dict), "expected a JSON object")
    return cast(dict[str, Json], value)


def array(value: Json) -> list[Json]:
    require(isinstance(value, list), "expected a JSON array")
    return cast(list[Json], value)


def text(value: Json) -> str:
    require(isinstance(value, str), "expected a string")
    return cast(str, value)


def integer(value: Json) -> int:
    require(type(value) is int, "expected an integer")
    return cast(int, value)


def read_json(path: Path) -> dict[str, Json]:
    return obj(cast(Json, json.loads(path.read_text())))


def atomic_text(path: Path, content: str) -> None:
    # Replace within one directory, with private permissions and durable metadata.
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w") as stream:
            _ = stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def save(path: Path, value: dict[str, Json]) -> None:
    atomic_text(path, json.dumps(value, indent=2, allow_nan=False) + "\n")


def command(argv: list[str]) -> str:
    result = subprocess.run(
        argv, capture_output=True, text=True, timeout=60, check=False
    )
    if result.returncode:
        raise BenchmarkError(
            f"{shlex.join(argv)}: exit {result.returncode}: {result.stderr.strip()}"
        )
    return result.stdout


def boot_id() -> str:
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def same_boot(expected: str, actual: str) -> None:
    require(
        bool(expected) and expected == actual,
        "Host boot ID changed; inspect pending Instance manually",
    )


def reply(value: Json, signature: str) -> Json:
    envelope = obj(value)
    require(envelope.get("type") == signature, f"expected D-Bus signature {signature}")
    data = array(envelope.get("data"))
    require(len(data) == 1, "expected one D-Bus return value")
    return data[0]


def prop(properties: dict[str, Json], name: str, signature: str) -> Json:
    variant = obj(properties.get(name))
    require(
        variant.get("type") == signature,
        f"invalid property {name}: expected {signature}",
    )
    return variant.get("data")


@dataclass(frozen=True)
class Execution:
    start: int
    end: int
    pid: int
    code: int
    status: int


def execution(properties: dict[str, Json], name: str) -> Execution:
    records = array(prop(properties, name, "a(sasbttttuii)"))
    require(len(records) == 1, f"{name}: expected exactly one command")
    record = array(records[0])
    require(len(record) == 10, f"{name}: invalid execution record")
    require(bool(text(record[0])), f"{name}: empty executable")
    require(bool(array(record[1])), f"{name}: empty argv")
    for argument in array(record[1]):
        _ = text(argument)
    require(type(record[2]) is bool, f"{name}: invalid ignore-errors flag")
    for value in record[3:]:
        require(integer(value) >= 0, f"{name}: negative execution field")
    return Execution(*(integer(record[i]) for i in (4, 6, 7, 8, 9)))


def invocation(properties: dict[str, Json]) -> str:
    data = array(prop(properties, "InvocationID", "ay"))
    require(len(data) == 16, "invalid InvocationID length")
    values = [integer(value) for value in data]
    require(
        all(0 <= value <= 255 for value in values) and any(values),
        "invalid InvocationID",
    )
    return bytes(values).hex()


def timings(unit: Json, service: Json, name: str) -> dict[str, Json]:
    u = obj(reply(unit, "a{sv}"))
    s = obj(reply(service, "a{sv}"))
    require(prop(u, "Id", "s") == name, "unit identity changed")
    identity = invocation(u)
    result = text(prop(s, "Result", "s"))
    if (prop(u, "ActiveState", "s"), prop(u, "SubState", "s"), result) != (
        "active",
        "running",
        "success",
    ):
        raise ActivationError(f"{name}: activation unsuccessful ({result})")
    end = integer(prop(u, "ActiveEnterTimestampMonotonic", "t"))
    pre, main, post = (
        execution(s, field) for field in ("ExecStartPre", "ExecStart", "ExecStartPost")
    )
    # systemd 261.2 spawns ExecStartPre before recording InactiveExitTimestamp.
    # Measure from the first execution, not the later unit-state transition.
    start = pre.start
    require(
        0 < start <= pre.end <= main.start <= post.start <= post.end <= end,
        "zero or unordered activation timestamps",
    )
    require(
        all(
            record.code == os.CLD_EXITED and record.status == 0
            for record in (pre, post)
        ),
        "unsuccessful startup execution",
    )
    require(
        main.pid > 0 and integer(prop(s, "MainPID", "u")) == main.pid,
        "main PID mismatch",
    )
    worker, boot, provision = (
        pre.end - pre.start,
        post.start - main.start,
        post.end - post.start,
    )
    return {
        "invocation_id": identity,
        "systemd_result": result,
        "main_pid": main.pid,
        "control_group": text(prop(s, "ControlGroup", "s")),
        "activation_us": end - start,
        "worker_us": worker,
        "boot_wait_us": boot,
        "provision_us": provision,
        "manager_gaps_us": end - start - worker - boot - provision,
    }


class Manager:
    def __init__(self, run: Command = command) -> None:
        self.run: Command = run

    def call(self, path: str, interface: str, method: str, *arguments: str) -> Json:
        return cast(
            Json,
            json.loads(
                self.run(
                    [
                        "busctl",
                        "--user",
                        "--json=short",
                        "call",
                        BUS,
                        path,
                        interface,
                        method,
                        *arguments,
                    ]
                )
            ),
        )

    def units(self) -> dict[str, str]:
        rows = array(
            reply(self.call(BUS_PATH, BUS + ".Manager", "ListUnits"), "a(ssssssouso)")
        )
        units: dict[str, str] = {}
        for item in rows:
            row = array(item)
            require(len(row) == 10, "invalid ListUnits row")
            name = text(row[0])
            if UNIT.fullmatch(name):
                require(name not in units, "duplicate ListUnits entry")
                units[name] = text(row[6])
        return units

    def properties(self, path: str, interface: str) -> Json:
        return self.call(
            path,
            "org.freedesktop.DBus.Properties",
            "GetAll",
            "s",
            BUS + "." + interface,
        )

    def journal(self, unit: str) -> str:
        return self.run(
            [
                "journalctl",
                "--user",
                "-u",
                unit,
                "-n",
                "200",
                "--no-pager",
                "-o",
                "json",
            ]
        )

    def cleanup(self, unit: str, state: Path, runtime: Path) -> None:
        require(UNIT.fullmatch(unit) is not None, "invalid cleanup unit")
        if unit not in self.units() and not state.exists() and not runtime.exists():
            return
        _ = self.run(["systemctl", "--user", "stop", unit])
        _ = self.run(["systemctl", "--user", "clean", "--what=state", unit])
        remaining = self.units()
        if unit in remaining:
            properties = obj(reply(self.properties(remaining[unit], "Unit"), "a{sv}"))
            if prop(properties, "ActiveState", "s") == "failed":
                _ = self.run(["systemctl", "--user", "reset-failed", unit])
        require(
            not state.exists() and not runtime.exists(),
            f"{unit}: cleanup left state or runtime directories",
        )


def new_unit(baseline: set[str], current: dict[str, str]) -> str | None:
    names = set(current) - baseline
    require(len(names) <= 1, f"inventory conflict; inspect manually: {sorted(names)}")
    return next(iter(names), None)


def instance_paths(name: str, manifest: dict[str, Json]) -> tuple[Path, Path]:
    match = UNIT.fullmatch(name)
    require(match is not None, "invalid Instance unit")
    assert match is not None
    identity = match[1]
    return (
        Path(text(manifest["state_base"])) / "drv.run" / identity,
        Path(text(manifest["runtime_base"])) / f"drv.run.{identity}",
    )


def prepare(output: Path, batch: str, manager: Manager) -> None:
    manifest = read_json(output / "manifest.json")
    same_boot(text(manifest["boot_id"]), boot_id())
    require(not (output / "pending.json").exists(), "pending trial requires recovery")
    directory = output / batch
    counter = directory / "counter.json"
    index = integer(read_json(counter)["next"]) if counter.exists() else 0
    trial = directory / "trials" / f"{index:04d}"
    trial.mkdir(parents=True, mode=0o700)
    save(
        output / "pending.json",
        {
            "batch": batch,
            "index": index,
            "boot_id": manifest["boot_id"],
            "baseline": list[Json](sorted(manager.units())),
            "unit": None,
        },
    )


def collect(
    name: str, path: str, trial: Path, manifest: dict[str, Json], manager: Manager
) -> dict[str, Json]:
    phase: dict[str, Json] = {
        "unit": name,
        "invocation_id": None,
        "systemd_result": None,
        "outcome": "collection_failure",
        "cleanup": "pending",
        **{field: None for field in METRICS},
    }
    try:
        unit = manager.properties(path, "Unit")
        save(trial / "unit.json", obj(unit))
        service = manager.properties(path, "Service")
        save(trial / "service.json", obj(service))
        u, s = obj(reply(unit, "a{sv}")), obj(reply(service, "a{sv}"))
        phase["invocation_id"] = invocation(u)
        phase["systemd_result"] = text(prop(s, "Result", "s"))
        measured = timings(unit, service, name)
        same_boot(text(manifest["boot_id"]), boot_id())
        state, runtime = instance_paths(name, manifest)
        require((runtime / "client.conf").is_file(), "client.conf not published")
        os.kill(integer(measured["main_pid"]), 0)
        for field in ("environment", "runner"):
            link = state / field
            require(link.is_symlink(), f"missing {field} symlink")
            phase[field] = str(link.resolve(strict=True))
        phase.update(measured)
        phase["outcome"] = "success"
    except ActivationError as error:
        phase.update(outcome="activation_failure", error=str(error))
    except (BenchmarkError, OSError, ValueError, subprocess.SubprocessError) as error:
        phase["error"] = str(error)
    try:
        atomic_text(trial / "journal.jsonl", manager.journal(name))
    except (BenchmarkError, OSError, subprocess.SubprocessError) as error:
        phase.update(outcome="collection_failure", journal_error=str(error))
    return phase


def conclude(output: Path, manager: Manager, *, recovery: bool = False) -> None:
    pending_path = output / "pending.json"
    if recovery and not pending_path.exists():
        return
    pending = read_json(pending_path)
    manifest = read_json(output / "manifest.json")
    same_boot(text(pending["boot_id"]), boot_id())
    same_boot(text(manifest["boot_id"]), boot_id())
    require(integer(manifest["uid"]) == os.getuid(), "Instance owner changed")
    batch, index = text(pending["batch"]), integer(pending["index"])
    require(batch in ("warmup", "measured") and index >= 0, "invalid pending trial")
    trial = output / batch / "trials" / f"{index:04d}"
    phase_path = trial / "phase.json"
    baseline = {text(name) for name in array(pending["baseline"])}
    current = manager.units()
    try:
        discovered = new_unit(baseline, current)
    except BenchmarkError as error:
        save(
            trial / "conflict.json",
            {
                "outcome": "inventory_conflict",
                "error": str(error),
                "new_units": list[Json](sorted(set(current) - baseline)),
            },
        )
        raise
    name = pending.get("unit")
    if name is None:
        name = discovered
        pending["unit"] = name
        save(pending_path, pending)
    else:
        require(
            text(name) not in baseline and discovered in (None, name),
            "pending unit inventory changed",
        )
    phase: dict[str, Json]
    if phase_path.exists():
        phase = read_json(phase_path)
    elif name is None:
        phase = {
            "unit": None,
            "invocation_id": None,
            "systemd_result": None,
            "outcome": "no_instance",
            "cleanup": "pending",
            **{field: None for field in METRICS},
        }
    elif text(name) not in current:
        phase = {
            "unit": name,
            "invocation_id": None,
            "systemd_result": None,
            "outcome": "collection_failure",
            "cleanup": "pending",
            "error": "Instance disappeared",
            **{field: None for field in METRICS},
        }
    else:
        phase = collect(text(name), current[text(name)], trial, manifest, manager)
    phase.update(schema_version=1, batch=batch, index=index)
    save(phase_path, phase)  # Freeze startup data before any stop/reset/clean.
    if name is not None:
        name = text(name)
        state, runtime = instance_paths(name, manifest)
        try:
            # A restart during collection invalidates our authority to clean this invocation.
            if name in current and phase.get("invocation_id") is not None:
                u = obj(reply(manager.properties(current[name], "Unit"), "a{sv}"))
                if prop(u, "ActiveState", "s") not in ("inactive", "failed"):
                    require(
                        invocation(u) == phase["invocation_id"],
                        "Instance invocation changed before cleanup",
                    )
            manager.cleanup(name, state, runtime)
        except (
            BenchmarkError,
            OSError,
            ValueError,
            subprocess.SubprocessError,
        ) as error:
            phase.update(cleanup="failed", cleanup_error=str(error))
            save(phase_path, phase)
            raise BenchmarkError(
                f"cleanup failed for {name}; retain {pending_path}: {error}"
            ) from error
    phase["cleanup"] = "success"
    save(phase_path, phase)
    save(output / batch / "counter.json", {"next": index + 1})
    pending_path.unlink()


def join_samples(
    export: dict[str, Json], phases: list[dict[str, Json]], batch: str, count: int
) -> list[dict[str, Json]]:
    results = array(export.get("results"))
    require(len(results) == 1, "expected one hyperfine result")
    result = obj(results[0])
    times, codes = array(result.get("times")), array(result.get("exit_codes"))
    require(
        len(times) == len(codes) == len(phases) == count,
        "incomplete or mismatched batch",
    )
    samples: list[dict[str, Json]] = []
    for index, (elapsed, code, phase) in enumerate(
        zip(times, codes, phases, strict=True)
    ):
        require(
            integer(phase.get("index")) == index and phase.get("batch") == batch,
            "trial index mismatch",
        )
        require(type(elapsed) in (int, float), "invalid hyperfine duration")
        duration = float(cast(int | float, elapsed))
        require(math.isfinite(duration) and duration >= 0, "invalid hyperfine duration")
        require(
            code is None or (type(code) is int and 0 <= integer(code) <= 255),
            "invalid exit code",
        )
        sample = dict(
            phase,
            activation_outcome=phase.get("outcome"),
            launcher_s=duration,
            launcher_exit_code=code,
        )
        if phase.get("cleanup") != "success":
            sample["outcome"] = "cleanup_failure"
        elif code == 124:
            sample["outcome"] = "timeout"
        elif code is None or (isinstance(code, int) and 128 < code < 128 + signal.NSIG):
            sample["outcome"] = "signal_or_forced_termination"
        elif code != 0 and phase.get("outcome") != "activation_failure":
            sample["outcome"] = "launcher_failure"
        if sample.get("outcome") == "success":
            require(
                bool(sample.get("unit")) and bool(sample.get("invocation_id")),
                "missing Instance identity",
            )
            for field in METRICS:
                require(integer(sample.get(field)) >= 0, f"invalid {field}")
        samples.append(sample)
    return samples


def load_batch(output: Path, batch: str, count: int) -> list[dict[str, Json]]:
    directory = output / batch
    phases = [
        read_json(path) for path in sorted((directory / "trials").glob("*/phase.json"))
    ]
    return join_samples(read_json(directory / "hyperfine.json"), phases, batch, count)


def summarize(samples: list[dict[str, Json]]) -> dict[str, Json]:
    measured = [sample for sample in samples if sample["batch"] == "measured"]
    successes = [sample for sample in measured if sample["outcome"] == "success"]
    metrics: dict[str, Json] = {}
    for field in ("launcher_s", *METRICS):
        values = [
            float(cast(int | float, sample[field]))
            / (1 if field == "launcher_s" else 1_000_000)
            for sample in successes
        ]
        metrics[field.removesuffix("_us") + ("_s" if field.endswith("_us") else "")] = (
            {
                "median": statistics.median(values),
                "min": min(values),
                "max": max(values),
            }
            if values
            else None
        )
    return {
        "schema_version": 1,
        "measured_count": len(measured),
        "successful_count": len(successes),
        "failure_count": len(measured) - len(successes),
        "metrics": metrics,
    }


def record_samples(output: Path, samples: list[dict[str, Json]]) -> None:
    atomic_text(
        output / "samples.jsonl",
        "".join(json.dumps(sample, allow_nan=False) + "\n" for sample in samples),
    )


@contextmanager
def owner_lock(
    runtime: Path, output: Path, *, recovery: bool = False
) -> Generator[None]:
    fd = os.open(
        runtime / "drv.run-benchmark.lock",
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(fd, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise BenchmarkError(
                "another benchmark owns the Instance owner lock"
            ) from error
        previous = lock.read().strip()
        if previous and (Path(previous) / "pending.json").exists():
            require(
                recovery and Path(previous) == output,
                f"recover the pending batch first: {previous}",
            )
        _ = lock.seek(0)
        _ = lock.truncate()
        _ = lock.write(str(output) + "\n")
        lock.flush()
        os.fsync(lock.fileno())
        yield
        if not (output / "pending.json").exists():
            _ = lock.seek(0)
            _ = lock.truncate()
            lock.flush()
            os.fsync(lock.fileno())


def positive(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def absolute(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise argparse.ArgumentTypeError("must be an absolute path")
    return path


def reference(value: str) -> str:
    if not value or value.startswith("-") or any(char.isspace() for char in value):
        raise argparse.ArgumentTypeError(
            "expected one nonempty Flake reference, without whitespace or leading '-' "
        )
    return value


def preflight(launcher: Path, bash: Path, output: Path, manager: Manager) -> Path:
    require(os.getuid() != 0, "run as a normal Instance owner, not root")
    require(not output.exists(), "output directory already exists")
    runtime = Path(f"/run/user/{os.getuid()}")
    require((runtime / "bus").is_socket(), "a running systemd user manager is required")
    require(
        os.access("/dev/kvm", os.R_OK | os.W_OK),
        "read/write access to /dev/kvm is required",
    )
    require(
        launcher.is_file() and os.access(launcher, os.X_OK),
        "packaged launcher is not executable",
    )
    require(
        bash.is_file() and os.access(bash, os.X_OK), "packaged Bash is not executable"
    )
    for dependency in (
        "hyperfine",
        "busctl",
        "systemctl",
        "systemd-path",
        "journalctl",
        "timeout",
        "env",
        "nix",
    ):
        require(
            shutil.which(dependency) is not None, f"missing dependency: {dependency}"
        )
    _ = manager.units()
    return runtime


def stop_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        _ = process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # The leader can exit before its children. Kill remaining group members too.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _ = process.wait()


def hyperfine(output: Path, batch: str, count: int, manifest: dict[str, Json]) -> None:
    directory = output / batch
    directory.mkdir(mode=0o700)
    hook = [sys.executable, str(Path(__file__).resolve())]
    measured = shlex.join(
        [
            # Keep timeout in the supervisor's process group for interrupt recovery.
            "timeout",
            "--foreground",
            "--kill-after=5s",
            f"{integer(manifest['timeout'])}s",
            "env",
            f"SSH_ORIGINAL_COMMAND={text(manifest['reference'])}",
            text(manifest["launcher"]),
            "exit",
        ]
    )
    argv = [
        "hyperfine",
        "--shell",
        text(manifest["bash"]),
        "--runs",
        str(count),
        "--ignore-failure",
        "--show-output",
        "--prepare",
        shlex.join([*hook, "prepare", "--output", str(output), "--batch", batch]),
        "--conclude",
        shlex.join([*hook, "conclude", "--output", str(output)]),
        "--export-json",
        str(directory / "hyperfine.json"),
        measured,
    ]
    with (directory / "hyperfine.log").open("wb") as log:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        try:
            status = process.wait()
        except BaseException:
            for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                _ = signal.signal(signum, signal.SIG_IGN)
            stop_group(process)
            raise
    require(status == 0, f"hyperfine failed; inspect {directory / 'hyperfine.log'}")


def interrupted(signum: int, _frame: FrameType | None) -> None:
    raise KeyboardInterrupt(f"signal {signum}")


class Arguments(argparse.Namespace):
    operation: str = ""
    output: Path = Path()
    launcher: Path = Path()
    bash: Path = Path()
    reference: str = ""
    runs: int = 20
    timeout: int = 300
    batch: str = ""


def run(args: Arguments) -> int:
    manager = Manager()
    output: Path = args.output
    with ExitStack() as resources:
        try:
            runtime = preflight(args.launcher, args.bash, output, manager)
            resources.enter_context(owner_lock(runtime, output))
            output.mkdir(mode=0o700, parents=True)
            manifest: dict[str, Json] = {
                "schema_version": 1,
                "uid": os.getuid(),
                "boot_id": boot_id(),
                "architecture": platform.machine(),
                "kernel": platform.release(),
                "current_system": str(Path("/run/current-system").resolve(strict=True)),
                "launcher": str(args.launcher.resolve(strict=True)),
                "bash": str(args.bash),
                "reference": args.reference,
                "runs": args.runs,
                "timeout": args.timeout,
                "runtime_base": str(runtime),
                "state_base": command(["systemd-path", "user-state-private"]).strip(),
                "cache_state": "warm-host-new-instance",
                "activation_timing": "exec-start-pre-start-to-active-enter",
                "operator_notes": {},
                "versions": {
                    "python": platform.python_version(),
                    "systemd": command(["systemctl", "--version"]).strip(),
                    "hyperfine": command(["hyperfine", "--version"]).strip(),
                    "nix": command(["nix", "--version"]).strip(),
                },
            }
            save(output / "manifest.json", manifest)
        except (
            BenchmarkError,
            OSError,
            ValueError,
            subprocess.SubprocessError,
        ) as error:
            print(f"preflight: {error}", file=sys.stderr)
            return 2
        samples: list[dict[str, Json]] = []
        complete = False
        error_message: str | None = None
        try:
            for batch, count in (("warmup", 1), ("measured", args.runs)):
                print(
                    f"{batch}: {count} run(s); log: {output / batch / 'hyperfine.log'}",
                    file=sys.stderr,
                )
                hyperfine(output, batch, count, manifest)
                samples.extend(load_batch(output, batch, count))
                record_samples(output, samples)
                if batch == "warmup":
                    require(
                        samples[0]["outcome"] == "success",
                        "warmup failed; measured batch not started",
                    )
            complete = True
        except (
            BenchmarkError,
            OSError,
            ValueError,
            subprocess.SubprocessError,
            KeyboardInterrupt,
        ) as error:
            error_message = str(error) or "interrupted"
        finally:
            # A second terminal signal must not interrupt cleanup halfway through.
            for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                _ = signal.signal(signum, signal.SIG_IGN)
            try:
                conclude(output, manager, recovery=True)
            except (
                BenchmarkError,
                OSError,
                ValueError,
                subprocess.SubprocessError,
            ) as error:
                complete = False
                error_message = f"{error_message or ''}; recovery failed: {error}"
            record_samples(output, samples)
            summary = summarize(samples)
            summary.update(complete=complete, error=error_message)
            save(output / "summary.json", summary)
        if error_message:
            print(error_message, file=sys.stderr)
        print(json.dumps(summary, indent=2))
        return 0 if complete and summary["failure_count"] == 0 else 1


def main(argv: list[str] | None = None) -> int:
    _ = os.umask(0o077)
    # Match the launcher's choice of user manager, including local su sessions.
    os.environ["XDG_RUNTIME_DIR"] = f"/run/user/{os.getuid()}"
    os.environ["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path=/run/user/{os.getuid()}/bus"
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    launch = sub.add_parser("run")
    _ = launch.add_argument("--launcher", type=absolute, required=True)
    _ = launch.add_argument("--bash", type=absolute, required=True)
    _ = launch.add_argument("--reference", type=reference, required=True)
    _ = launch.add_argument("--runs", type=positive, default=20)
    _ = launch.add_argument("--timeout", type=positive, default=300)
    _ = launch.add_argument("--output", type=absolute, required=True)
    for name in ("prepare", "conclude", "recover"):
        hook = sub.add_parser(name)
        _ = hook.add_argument("--output", type=absolute, required=True)
        if name == "prepare":
            _ = hook.add_argument(
                "--batch", choices=("warmup", "measured"), required=True
            )
    args = parser.parse_args(argv, namespace=Arguments())
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        _ = signal.signal(signum, interrupted)
    try:
        if args.operation == "run":
            return run(args)
        if args.operation == "prepare":
            prepare(args.output, args.batch, Manager())
        elif args.operation == "conclude":
            conclude(args.output, Manager())
        else:
            with owner_lock(
                Path(os.environ["XDG_RUNTIME_DIR"]), args.output, recovery=True
            ):
                conclude(args.output, Manager(), recovery=True)
        return 0
    except (
        BenchmarkError,
        OSError,
        ValueError,
        subprocess.SubprocessError,
        KeyboardInterrupt,
    ) as error:
        print(str(error) or "interrupted", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
