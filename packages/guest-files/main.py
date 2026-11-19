import argparse
import errno
import os
import shutil
import stat
import subprocess
import tempfile
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from pathlib import Path, PurePosixPath


class Arguments(argparse.Namespace):
    inputs: Path = Path()
    environment: Path = Path()
    output: Path = Path()
    reserved_path: list[PurePosixPath] | None = None


@contextmanager
def directory(path: str | Path, parent: int | None = None) -> Generator[int]:
    descriptor = os.open(
        path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent
    )
    try:
        yield descriptor
    finally:
        os.close(descriptor)


def permissions(descriptor: int, guest: PurePosixPath) -> int:
    mode = stat.S_IMODE(os.fstat(descriptor).st_mode)
    try:
        attributes = os.listxattr(descriptor)
    except OSError as error:
        # Filesystems without xattrs (and the Nix sandbox) report ENOTSUP.
        if error.errno != errno.ENOTSUP:
            raise
        attributes = []
    if mode & ~0o777 or attributes:
        raise ValueError(f"unsupported guest metadata: {guest}")
    return mode


def merge(
    source: int,
    target: Path,
    directories: dict[Path, int],
    reserved: Sequence[PurePosixPath],
    guest: PurePosixPath,
) -> None:
    for name in sorted(os.listdir(source)):
        destination = target / name
        metadata = os.stat(name, dir_fd=source, follow_symlinks=False)
        guest_path = guest / name
        is_directory = stat.S_ISDIR(metadata.st_mode)
        if any(
            guest_path.is_relative_to(path)
            or (not is_directory and path.is_relative_to(guest_path))
            for path in reserved
        ):
            raise ValueError(f"reserved guest destination: {guest_path}")
        if is_directory:
            with directory(name, source) as child:
                mode = permissions(child, guest_path)
                if destination in directories and directories[destination] != mode:
                    raise ValueError(
                        f"conflicting directory permissions: {destination}"
                    )
                destination.mkdir(exist_ok=True)
                directories[destination] = mode
                merge(child, destination, directories, reserved, guest_path)
        elif stat.S_ISREG(metadata.st_mode):
            descriptor = os.open(
                name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source
            )
            with os.fdopen(descriptor, "rb") as contents:
                metadata = os.fstat(contents.fileno())
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                    raise ValueError(f"not an independent regular file: {destination}")
                mode = permissions(contents.fileno(), guest_path)
                with destination.open("xb") as output:
                    shutil.copyfileobj(contents, output)
                destination.chmod(mode)
        else:
            raise ValueError(f"unsupported input type: {destination}")


def assemble(
    inputs: Path,
    environment: Path,
    output: Path,
    reserved: Sequence[PurePosixPath],
) -> None:
    if any(
        path.anchor != "/" or path == PurePosixPath("/") or ".." in path.parts
        for path in reserved
    ):
        raise ValueError(
            "reserved guest paths must be absolute non-root paths without traversal"
        )
    with tempfile.TemporaryDirectory(
        prefix=".guest-files-", dir=output.parent
    ) as temporary:
        workspace = Path(temporary)
        staging = workspace / "tree"
        rootfs = staging / "rootfs"
        rootfs.mkdir(parents=True)
        directories: dict[Path, int] = {}
        with directory(inputs) as sources:
            for producer in sorted(os.listdir(sources)):
                with directory(producer, sources) as source:
                    merge(source, rootfs, directories, reserved, PurePosixPath("/"))
        for path, mode in sorted(directories.items(), reverse=True):
            path.chmod(mode)
        rootfs.chmod(0o755)
        _ = (staging / "environment").write_text(
            str(environment.resolve(strict=True)) + "\n"
        )
        image = workspace / "seed.img"
        _ = subprocess.run(
            [
                "mkfs.erofs",
                "-d0",
                "-b4096",
                "-x-1",
                "--all-root",
                "-L",
                "drv-run-seed",
                str(image),
                str(staging),
            ],
            check=True,
        )
        image.chmod(0o600)
        os.link(image, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument("--inputs", required=True, type=Path)
    _ = parser.add_argument("--environment", required=True, type=Path)
    _ = parser.add_argument("--output", required=True, type=Path)
    _ = parser.add_argument("--reserved-path", action="append", type=PurePosixPath)
    args = parser.parse_args(namespace=Arguments())
    assemble(args.inputs, args.environment, args.output, args.reserved_path or [])


if __name__ == "__main__":
    main()
