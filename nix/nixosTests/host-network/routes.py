"""Exercise the production route-overlap predicate without a network namespace."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> None:
    predicate = Path(sys.argv[1]).resolve()
    slot = {"tap": "drv-op0", "subnet": "10.231.0.0/30"}
    cases = [
        ([], True),
        ([{"dst": "default", "gateway": "192.168.1.1"}], True),
        ([{"dst": "10.231.0.4/30", "dev": "other"}], True),
        ([{"dst": "10.230.255.255/32", "dev": "other"}], True),
        ([{"dst": "10.231.0.0/30", "dev": "other"}], False),
        ([{"dst": "10.231.0.0/24", "dev": "other"}], False),
        ([{"dst": "10.0.0.0/8", "table": 200}], False),
        ([{"dst": "0.0.0.0/1", "dev": "vpn"}], False),
        ([{"dst": "10.231.0.0/31", "dev": "other"}], False),
        ([{"dst": "10.231.0.3", "type": "local", "table": "local"}], False),
        ([{"dst": "10.231.0.2", "type": "blackhole", "table": 200}], False),
        ([{"dst": "10.231.0.0/30", "dev": "drv-op0", "protocol": "kernel"}], True),
        ([{"dst": "10.231.0.1", "dev": "drv-op0", "protocol": "kernel", "type": "local"}], True),
        ([{"dst": "10.231.0.0/30", "dev": "drv-op0", "protocol": "static"}], False),
        ([{"dst": "10.231.0.0/30", "dev": "other", "protocol": "kernel"}], False),
    ]
    with tempfile.TemporaryDirectory() as directory:
        config = Path(directory) / "config.json"
        config.write_text(json.dumps({"slots": [slot]}))
        for routes, allowed in cases:
            result = subprocess.run(
                ["jq", "-e", "--slurpfile", "config", str(config), "-f", str(predicate)],
                input=json.dumps(routes),
                text=True,
                stdout=subprocess.DEVNULL,
                check=False,
            )
            assert result.returncode == (0 if allowed else 1), (routes, result.returncode)


if __name__ == "__main__":
    main()
