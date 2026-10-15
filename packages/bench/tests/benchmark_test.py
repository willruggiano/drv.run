import json
import os
import shutil
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from typing import override

from .. import main as b

NAME = "drv.run@Test123.service"
PEER = "drv.run@Peer456.service"


def variant(signature: str, data: b.Json) -> b.Json:
    return {"type": signature, "data": data}


def envelope(properties: dict[str, b.Json]) -> b.Json:
    return {"type": "a{sv}", "data": [properties]}


def properties(raw: b.Json) -> dict[str, b.Json]:
    return b.obj(b.reply(raw, "a{sv}"))


def fixture(name: str = NAME) -> dict[str, b.Json]:
    def execution(start: int, end: int, pid: int) -> b.Json:
        return variant(
            "a(sasbttttuii)",
            [
                [
                    "/nix/store/example/bin/program",
                    ["program"],
                    False,
                    1000,
                    start,
                    2000 if end else 0,
                    end,
                    pid,
                    os.CLD_EXITED if end else 0,
                    0,
                ],
            ],
        )

    return {
        "Unit": envelope(
            {
                "Id": variant("s", name),
                "ActiveState": variant("s", "active"),
                "SubState": variant("s", "running"),
                "InvocationID": variant("ay", list(range(16))),
                "InactiveExitTimestampMonotonic": variant("t", 100),
                "ActiveEnterTimestampMonotonic": variant("t", 1000),
            }
        ),
        "Service": envelope(
            {
                "Result": variant("s", "success"),
                "ControlGroup": variant("s", "/test"),
                "MainPID": variant("u", os.getpid()),
                "ExecStartPre": execution(110, 210, 99),
                "ExecStart": execution(220, 0, os.getpid()),
                "ExecStartPost": execution(800, 990, 101),
            }
        ),
    }


def phase(index: int = 0, batch: str = "measured") -> dict[str, b.Json]:
    raw = fixture()
    return dict(
        b.timings(raw["Unit"], raw["Service"], NAME),
        schema_version=1,
        batch=batch,
        index=index,
        unit=NAME,
        outcome="success",
        cleanup="success",
    )


def export(times: list[b.Json], codes: list[b.Json]) -> dict[str, b.Json]:
    return {"results": [{"times": times, "exit_codes": codes}]}


class TimingsTest(unittest.TestCase):
    def test_integer_durations_and_running_main(self) -> None:
        result = phase()
        self.assertEqual(
            [result[field] for field in b.METRICS], [890, 100, 580, 190, 20]
        )
        self.assertEqual(result["invocation_id"], bytes(range(16)).hex())

    def test_worker_starts_before_unit_leaves_inactive(self) -> None:
        raw = fixture()
        # systemd records the activating transition after spawning ExecStartPre.
        properties(raw["Unit"])["InactiveExitTimestampMonotonic"] = variant("t", 120)
        result = b.timings(raw["Unit"], raw["Service"], NAME)
        self.assertEqual(
            [result[field] for field in b.METRICS], [890, 100, 580, 190, 20]
        )

    def test_bad_properties_are_rejected(self) -> None:
        cases: list[tuple[str, str, b.Json]] = [
            ("Unit", "ActiveEnterTimestampMonotonic", variant("t", 900)),
            ("Unit", "ActiveEnterTimestampMonotonic", variant("s", "1000")),
            ("Unit", "InvocationID", variant("ay", list[b.Json]([0] * 16))),
            ("Unit", "InvocationID", variant("ay", list[b.Json]([256] * 16))),
            ("Unit", "InvocationID", variant("ay", [1])),
            ("Unit", "Id", variant("s", PEER)),
            ("Service", "ExecStartPre", variant("a(sasbttttuii)", [])),
            ("Service", "MainPID", variant("u", 0)),
            ("Service", "Result", None),
        ]
        for interface, field, value in cases:
            with self.subTest(interface=interface, field=field, value=value):
                raw = fixture()
                properties(raw[interface])[field] = value
                with self.assertRaises(b.BenchmarkError):
                    _ = b.timings(raw["Unit"], raw["Service"], NAME)

    def test_execution_validation(self) -> None:
        for field, index, value in [
            ("ExecStartPre", 4, 0),
            ("ExecStartPre", 6, 90),
            ("ExecStartPost", 9, 7),
            ("ExecStartPost", 8, os.CLD_KILLED),
        ]:
            raw = fixture()
            record = b.array(
                b.array(b.prop(properties(raw["Service"]), field, "a(sasbttttuii)"))[0]
            )
            record[index] = value
            with (
                self.subTest(field=field, index=index),
                self.assertRaises(b.BenchmarkError),
            ):
                _ = b.timings(raw["Unit"], raw["Service"], NAME)
        raw = fixture()
        records = b.array(
            b.prop(properties(raw["Service"]), "ExecStartPre", "a(sasbttttuii)")
        )
        records.append(deepcopy(records[0]))
        with self.assertRaises(b.BenchmarkError):
            _ = b.timings(raw["Unit"], raw["Service"], NAME)

    def test_activation_failure(self) -> None:
        raw = fixture()
        properties(raw["Service"])["Result"] = variant("s", "exit-code")
        with self.assertRaises(b.ActivationError):
            _ = b.timings(raw["Unit"], raw["Service"], NAME)

    def test_boot_identity(self) -> None:
        b.same_boot("boot-a", "boot-a")
        for expected, actual in [("", ""), ("boot-a", "boot-b")]:
            with self.subTest(expected=expected), self.assertRaises(b.BenchmarkError):
                b.same_boot(expected, actual)


class ReportTest(unittest.TestCase):
    def test_order_failures_and_statistics(self) -> None:
        phases = [phase(index) for index in range(6)]
        samples = b.join_samples(
            export([2, 100, 200, 300, 400, 500], [0, 7, 124, None, 137, 255]),
            phases,
            "measured",
            6,
        )
        self.assertEqual(
            [sample["outcome"] for sample in samples],
            [
                "success",
                "launcher_failure",
                "timeout",
                "signal_or_forced_termination",
                "signal_or_forced_termination",
                "launcher_failure",
            ],
        )
        summary = b.summarize(samples)
        self.assertEqual(summary["measured_count"], 6)
        self.assertEqual(summary["successful_count"], 1)
        self.assertEqual(summary["failure_count"], 5)
        self.assertEqual(
            b.obj(summary["metrics"])["launcher_s"],
            {"median": 2.0, "min": 2.0, "max": 2.0},
        )
        self.assertEqual(
            b.obj(b.obj(summary["metrics"])["activation_s"])["median"], 0.00089
        )

    def test_warmup_is_not_summarized(self) -> None:
        samples = b.join_samples(export([999], [0]), [phase(0, "warmup")], "warmup", 1)
        summary = b.summarize(samples)
        self.assertEqual(summary["measured_count"], 0)
        self.assertIsNone(b.obj(summary["metrics"])["launcher_s"])

    def test_failed_phases_remain_failed(self) -> None:
        failed = phase()
        failed["outcome"] = "activation_failure"
        self.assertEqual(
            b.join_samples(export([1], [1]), [failed], "measured", 1)[0]["outcome"],
            "activation_failure",
        )
        failed["cleanup"] = "failed"
        self.assertEqual(
            b.join_samples(export([1], [0]), [failed], "measured", 1)[0]["outcome"],
            "cleanup_failure",
        )

    def test_reject_incomplete_or_invalid_exports(self) -> None:
        cases: list[dict[str, b.Json]] = [
            export([], []),
            export([1], []),
            export([True], [0]),
            export([-1], [0]),
            export([float("nan")], [0]),
            export([1], [False]),
            export([1], [256]),
            {"results": []},
        ]
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(b.BenchmarkError):
                _ = b.join_samples(raw, [phase()], "measured", 1)
        with self.assertRaises(b.BenchmarkError):
            _ = b.join_samples(export([1], [0]), [phase(1)], "measured", 1)
        with self.assertRaises(b.BenchmarkError):
            _ = b.join_samples(export([1], [0]), [phase(0, "warmup")], "measured", 1)


class FakeSystemd:
    """Only the busctl/systemctl/journalctl boundary; real collector and files."""

    def __init__(self, manifest: dict[str, b.Json]) -> None:
        self.manifest: dict[str, b.Json] = manifest
        self.units: dict[str, dict[str, b.Json]] = {}
        self.actions: list[tuple[str, ...]] = []
        self.fail_clean: bool = False

    @staticmethod
    def path(name: str) -> str:
        match = b.UNIT.fullmatch(name)
        assert match is not None
        return "/units/" + match[1]

    def add(self, name: str) -> None:
        self.units[name] = fixture(name)
        state, runtime = b.instance_paths(name, self.manifest)
        state.mkdir(parents=True)
        runtime.mkdir(parents=True)
        (runtime / "client.conf").touch()
        for field in ("runner", "environment"):
            target = state / (field + "-target")
            target.mkdir()
            (state / field).symlink_to(target)

    def run(self, argv: list[str]) -> str:
        if argv[0] == "busctl":
            if argv[7] == "ListUnits":
                rows: list[b.Json] = [
                    [
                        name,
                        "",
                        "loaded",
                        "active",
                        "running",
                        "",
                        self.path(name),
                        0,
                        "",
                        "/",
                    ]
                    for name in self.units
                ]
                return json.dumps({"type": "a(ssssssouso)", "data": [rows]})
            name = next(name for name in self.units if self.path(name) == argv[5])
            return json.dumps(self.units[name][argv[9].rsplit(".", 1)[1]])
        if argv[0] == "journalctl":
            return ""
        if argv[0] == "systemctl":
            name = argv[-1]
            self.actions.append(tuple(argv[2:]))
            if argv[2] == "stop":
                properties(self.units[name]["Unit"])["ActiveState"] = variant(
                    "s", "inactive"
                )
            elif argv[2] == "clean":
                if self.fail_clean:
                    raise b.BenchmarkError("injected cleanup failure")
                for path in b.instance_paths(name, self.manifest):
                    shutil.rmtree(path)
                del self.units[name]
            else:
                raise AssertionError(argv)
            return ""
        raise AssertionError(argv)


class LifecycleTest(unittest.TestCase):
    # unittest runs setUp before each test; failed setup prevents test execution.
    output: Path  # pyright: ignore[reportUninitializedInstanceVariable]
    manifest: dict[str, b.Json]  # pyright: ignore[reportUninitializedInstanceVariable]
    fake: FakeSystemd  # pyright: ignore[reportUninitializedInstanceVariable]
    manager: b.Manager  # pyright: ignore[reportUninitializedInstanceVariable]

    @override
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name)
        self.manifest = {
            "uid": os.getuid(),
            "boot_id": b.boot_id(),
            "state_base": str(self.output / "state"),
            "runtime_base": str(self.output / "runtime"),
        }
        b.save(self.output / "manifest.json", self.manifest)
        self.fake = FakeSystemd(self.manifest)
        self.manager = b.Manager(self.fake.run)

    def trial(self) -> Path:
        return self.output / "measured" / "trials" / "0000"

    def test_preserve_peer_collect_before_cleanup_and_recover_twice(self) -> None:
        self.fake.add(PEER)
        original = deepcopy(self.fake.units[PEER])
        b.prepare(self.output, "measured", self.manager)
        self.fake.add(NAME)
        b.conclude(self.output, self.manager, recovery=True)
        b.conclude(self.output, self.manager, recovery=True)
        self.assertEqual(self.fake.units, {PEER: original})
        self.assertEqual(
            self.fake.actions, [("stop", NAME), ("clean", "--what=state", NAME)]
        )
        self.assertFalse((self.output / "pending.json").exists())
        self.assertEqual(b.read_json(self.trial() / "phase.json")["outcome"], "success")
        self.assertEqual(b.read_json(self.trial() / "phase.json")["cleanup"], "success")
        frozen = b.read_json(self.trial() / "unit.json")
        self.assertEqual(b.prop(properties(frozen), "ActiveState", "s"), "active")
        for path in b.instance_paths(NAME, self.manifest):
            self.assertFalse(path.exists())
        for path in b.instance_paths(PEER, self.manifest):
            self.assertTrue(path.exists())

    def test_pending_trial_blocks_prepare(self) -> None:
        b.prepare(self.output, "measured", self.manager)
        with self.assertRaises(b.BenchmarkError):
            b.prepare(self.output, "measured", self.manager)

    def test_ambiguous_inventory_never_cleans(self) -> None:
        b.prepare(self.output, "measured", self.manager)
        self.fake.add(NAME)
        self.fake.add(PEER)
        with self.assertRaises(b.BenchmarkError):
            b.conclude(self.output, self.manager)
        self.assertEqual(self.fake.actions, [])
        self.assertEqual(set(self.fake.units), {NAME, PEER})
        self.assertEqual(
            b.read_json(self.trial() / "conflict.json")["outcome"], "inventory_conflict"
        )
        self.assertTrue((self.output / "pending.json").exists())

    def test_no_instance(self) -> None:
        b.prepare(self.output, "measured", self.manager)
        b.conclude(self.output, self.manager)
        phase = b.read_json(self.trial() / "phase.json")
        self.assertEqual(phase["outcome"], "no_instance")
        self.assertIsNone(phase["activation_us"])
        self.assertEqual(self.fake.actions, [])

    def test_cleanup_failure_preserves_snapshot_and_is_recoverable(self) -> None:
        b.prepare(self.output, "measured", self.manager)
        self.fake.add(NAME)
        self.fake.fail_clean = True
        with self.assertRaises(b.BenchmarkError):
            b.conclude(self.output, self.manager)
        snapshot = b.read_json(self.trial() / "unit.json")
        self.assertTrue((self.output / "pending.json").exists())
        self.fake.fail_clean = False
        b.conclude(self.output, self.manager, recovery=True)
        self.assertEqual(b.read_json(self.trial() / "unit.json"), snapshot)
        self.assertEqual(b.read_json(self.trial() / "phase.json")["cleanup"], "success")

    def test_boot_change_never_cleans(self) -> None:
        b.prepare(self.output, "measured", self.manager)
        self.fake.add(NAME)
        pending = b.read_json(self.output / "pending.json")
        pending["boot_id"] = "different-boot"
        b.save(self.output / "pending.json", pending)
        with self.assertRaises(b.BenchmarkError):
            b.conclude(self.output, self.manager, recovery=True)
        self.assertEqual(self.fake.actions, [])

    def test_failed_activation_keeps_raw_records_and_cleans(self) -> None:
        b.prepare(self.output, "measured", self.manager)
        self.fake.add(NAME)
        properties(self.fake.units[NAME]["Service"])["Result"] = variant(
            "s", "exit-code"
        )
        b.conclude(self.output, self.manager)
        phase = b.read_json(self.trial() / "phase.json")
        self.assertEqual(phase["outcome"], "activation_failure")
        self.assertIsNone(phase["activation_us"])
        self.assertTrue((self.trial() / "service.json").is_file())
        self.assertEqual(self.fake.units, {})

    def test_invalid_snapshot_still_cleans_the_identified_instance(self) -> None:
        b.prepare(self.output, "measured", self.manager)
        self.fake.add(NAME)
        del properties(self.fake.units[NAME]["Service"])["ExecStartPost"]
        b.conclude(self.output, self.manager)
        phase = b.read_json(self.trial() / "phase.json")
        self.assertEqual(phase["outcome"], "collection_failure")
        self.assertIsNone(phase["activation_us"])
        self.assertEqual(phase["cleanup"], "success")
        self.assertEqual(self.fake.units, {})

    def test_owner_lock_excludes_another_batch(self) -> None:
        runtime = self.output / "lock-runtime"
        runtime.mkdir()
        with (
            b.owner_lock(runtime, self.output),
            self.assertRaises(b.BenchmarkError),
            b.owner_lock(runtime, self.output / "another"),
        ):
            self.fail("concurrent batch acquired the owner lock")
        with b.owner_lock(runtime, self.output):
            self.assertEqual(
                (runtime / "drv.run-benchmark.lock").stat().st_mode & 0o777, 0o600
            )

    def test_owner_lock_requires_recovery_of_a_pending_batch(self) -> None:
        runtime = self.output / "lock-runtime"
        runtime.mkdir()
        with b.owner_lock(runtime, self.output):
            b.prepare(self.output, "measured", self.manager)
        with (
            self.assertRaises(b.BenchmarkError),
            b.owner_lock(runtime, self.output / "another"),
        ):
            self.fail("unresolved pending batch was ignored")
        with b.owner_lock(runtime, self.output, recovery=True):
            b.conclude(self.output, self.manager, recovery=True)
        self.assertFalse((self.output / "pending.json").exists())

    def test_private_atomic_files(self) -> None:
        path = self.output / "private.json"
        b.save(path, {"version": 1})
        b.save(path, {"version": 2})
        self.assertEqual(b.read_json(path), {"version": 2})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    _ = unittest.main()
