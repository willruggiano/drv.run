import tempfile
import unittest
from pathlib import Path
from typing import override

from .. import benchmark as b
from .. import report
from .benchmark_test import export, fixture, phase


class ReportTest(unittest.TestCase):
    output: Path = Path()

    @override
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name)
        b.save(self.output / "manifest.json", {"runs": 1})
        samples: list[dict[str, b.Json]] = []
        for batch in ("warmup", "measured"):
            directory = self.output / batch
            trial = directory / "trials" / "0000"
            trial.mkdir(parents=True)
            raw = fixture()
            b.save(trial / "unit.json", b.obj(raw["Unit"]))
            b.save(trial / "service.json", b.obj(raw["Service"]))
            b.save(trial / "phase.json", phase(batch=batch))
            b.save(directory / "hyperfine.json", export([1.0], [0]))
            samples.extend(b.load_batch(self.output, batch, 1))
        summary = b.summarize(samples)
        summary.update(complete=True, error=None)
        b.save(self.output / "summary.json", summary)
        b.record_samples(self.output, samples)

    def test_validated_measurement(self) -> None:
        result = report.validate(self.output)
        self.assertEqual(b.obj(result["summary"])["successful_count"], 1)
        self.assertEqual(len(b.array(result["samples"])), 2)

    def test_pending_cleanup_is_rejected(self) -> None:
        b.save(self.output / "pending.json", {})
        with self.assertRaises(b.BenchmarkError):
            _ = report.validate(self.output)

    def test_modified_timing_is_rejected(self) -> None:
        path = self.output / "measured" / "trials" / "0000" / "phase.json"
        data = b.read_json(path)
        data["worker_us"] = 999
        b.save(path, data)
        with self.assertRaises(b.BenchmarkError):
            _ = report.validate(self.output)

    def test_failed_warmup_is_rejected(self) -> None:
        b.save(self.output / "warmup" / "hyperfine.json", export([1.0], [1]))
        with self.assertRaises(b.BenchmarkError):
            _ = report.validate(self.output)

    def test_inconsistent_summary_is_rejected(self) -> None:
        path = self.output / "summary.json"
        data = b.read_json(path)
        data["successful_count"] = 42
        b.save(path, data)
        with self.assertRaises(b.BenchmarkError):
            _ = report.validate(self.output)

    def test_unmanaged_section_is_not_overwritten(self) -> None:
        path = self.output / "document.md"
        _ = path.write_text("# Benchmarks\n\n## Time to Shell\n")
        with self.assertRaises(b.BenchmarkError):
            report.update_document(path, report.render([]))
