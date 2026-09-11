#!/usr/bin/env python3
"""Physical extent lookup for the APFS verification job (Darwin only).

``fcntl(fd, F_LOG2PHYS_EXT, &log2phys)`` asks the XNU kernel where a byte range
of a file physically lives.  The CI job samples a file's block map with it and
compares the source's and clone's device offsets; that is the only in-guest way
to prove an APFS clone genuinely shares extents.

Why this is a separate process instead of a ``bun:ffi`` binding
---------------------------------------------------------------

Darwin's ``fcntl`` is **variadic** -- ``int fcntl(int, int, ...)`` (XNU
``bsd/sys/fcntl.h``) -- and ``bun:ffi`` cannot declare a variadic prototype
(``FFIFunction.args`` is fixed-arity).  On x86_64 the System V ABI happens to
pass the third argument the same way whether the callee reads it as a fixed or
an anonymous argument, so the fixed-arity binding appeared to work and even
produced correct Intel evidence.  On arm64 (AAPCS64) the anonymous argument is
not read from the same place, so the kernel dereferences a garbage pointer and
the whole Bun process faults before it can write its report.

Python's ``ctypes`` cannot express varargs either, but it does not matter here:
the call executes in the C runtime of a **child process**.  A bad ABI (or a
kernel refusal) therefore becomes a non-zero child exit the caller can fall
back from, never a crash of the verification process.  ``use_errno=True`` and
passing the struct by pointer keep the interface to libSystem narrow.

Usage
-----

    log2phys.py PATH --stride BYTES [--max-samples N] [--offset N ...]

Without ``--offset`` the whole file is sampled at ``stride``-byte intervals
(``--max-samples`` caps the count).  With one or more ``--offset`` arguments
only those logical offsets are queried.

Output (stdout), one line per queried offset, tab-separated::

    <logical offset>\t<device offset>\t<contiguous bytes>

Exit codes
----------

    0  success
    2  usage error
    3  not Darwin (``F_LOG2PHYS_EXT`` does not exist on this platform)
    4  the file could not be opened
    5  the kernel refused ``F_LOG2PHYS_EXT`` (stderr names the errno)
"""

import ctypes
import errno
import itertools
import os
import sys

#: ``#define F_LOG2PHYS_EXT 65`` (XNU ``bsd/sys/fcntl.h``).
F_LOG2PHYS_EXT = 65

#: ``--stride`` / ``--max-samples`` are clamped to a sane range so a typo in
#: CI cannot make the helper spin for hours or allocate unbounded memory.
MAX_SAMPLES_LIMIT = 10_000_000

USAGE = "usage: log2phys.py PATH --stride BYTES [--max-samples N] [--offset N ...]"


class Log2Phys(ctypes.Structure):
    """``struct log2phys`` from XNU ``bsd/sys/fcntl.h``.

    ``#pragma pack(4)`` makes it 4 + 8 + 8 = 20 bytes, not 24.  On an in/out
    call ``l2p_contigbytes`` is the queried byte count and ``l2p_devoffset`` is
    the logical offset; the kernel overwrites them with the contiguous byte
    count and the device offset.
    """

    _pack_ = 4
    # Python 3.14 deprecates an implicit layout when `_pack_` is set. "ms"
    # is the layout the implicit default already used, and it matches clang's
    # `#pragma pack(4)` offsets (0, 4, 12; size 20) for this field sequence.
    # Older Pythons (macOS system python3 is 3.9) ignore the attribute.
    _layout_ = "ms"
    _fields_ = [
        ("l2p_flags", ctypes.c_uint32),
        ("l2p_contigbytes", ctypes.c_int64),
        ("l2p_devoffset", ctypes.c_int64),
    ]


class UsageError(Exception):
    """The command line did not match the documented interface."""


def _as_int(value, flag, minimum):
    try:
        parsed = int(value, 10)
    except ValueError:
        raise UsageError(f"{flag} expects an integer, got {value!r}") from None
    if parsed < minimum:
        raise UsageError(f"{flag} must be >= {minimum}, got {parsed}")
    return parsed


def _flag_value(argv, index, arg):
    """Value of ``--flag value`` or ``--flag=value``; returns ``(value, next_index)``."""
    name, _, inline = arg.partition("=")
    if inline:
        return inline, index
    if index + 1 >= len(argv):
        raise UsageError(f"{name} needs a value")
    return argv[index + 1], index + 1


#: Options that consume a value; each maps to the accumulator it feeds.
VALUE_OPTIONS = ("--stride", "--max-samples", "--offset")


def _store_option(name, value, state):
    if name == "--stride":
        state["stride"] = _as_int(value, name, 1)
    elif name == "--max-samples":
        state["max_samples"] = _as_int(value, name, 1)
    else:
        state["offsets"].append(_as_int(value, name, 0))


def parse_args(argv):
    """Return ``(path, stride, max_samples, offsets)`` or raise ``UsageError``.

    Argument parsing is deliberately separate from every platform call so the
    contract can be tested on Linux (see ``log2phys.test.ts``).
    """
    path = None
    state = {"stride": None, "max_samples": None, "offsets": []}

    index = 0
    while index < len(argv):
        arg = argv[index]
        name = arg.partition("=")[0]
        if name in VALUE_OPTIONS:
            value, index = _flag_value(argv, index, arg)
            _store_option(name, value, state)
        elif arg.startswith("-"):
            raise UsageError(f"unknown option: {arg}")
        elif path is None:
            path = arg
        else:
            raise UsageError(f"unexpected argument: {arg}")
        index += 1

    if path is None:
        raise UsageError("missing PATH")
    if state["stride"] is None:
        raise UsageError("missing --stride BYTES (the bytes queried per sample)")
    max_samples = state["max_samples"]
    if max_samples is not None:
        max_samples = min(max_samples, MAX_SAMPLES_LIMIT)
    return path, state["stride"], max_samples, state["offsets"]


def sampled_offsets(file_size, stride, max_samples, explicit):
    """The logical offsets to query: the explicit list, or a strided walk."""
    if explicit:
        return explicit
    walk = range(0, file_size, stride)
    return (
        list(itertools.islice(walk, max_samples))
        if max_samples is not None
        else list(walk)
    )


def query(fcntl, fd, offset, stride):
    """One ``F_LOG2PHYS_EXT`` probe; returns ``(device_offset, contig_bytes)``.

    ``argtypes`` is intentionally left unset: ``fcntl`` is variadic and ctypes
    cannot declare that, so the ``c_int``/``byref`` arguments are marshalled by
    the runtime and the call executes in this process's C runtime rather than
    in Bun's.
    """
    buf = Log2Phys(0, stride, offset)
    ctypes.set_errno(0)
    if fcntl(fd, F_LOG2PHYS_EXT, ctypes.byref(buf)) == -1:
        number = ctypes.get_errno()
        raise OSError(number, errno.errorcode.get(number, f"ERRNO_{number}"))
    return buf.l2p_devoffset, buf.l2p_contigbytes


def run(path, stride, max_samples, offsets):
    fd = os.open(path, os.O_RDONLY)
    try:
        file_size = os.fstat(fd).st_size
        libc = ctypes.CDLL(None, use_errno=True)
        fcntl = libc.fcntl
        fcntl.restype = ctypes.c_int

        lines = []
        for offset in sampled_offsets(file_size, stride, max_samples, offsets):
            try:
                device_offset, contiguous = query(fcntl, fd, offset, stride)
            except OSError as error:
                print(
                    f"log2phys: fcntl(F_LOG2PHYS_EXT) failed at offset {offset}: "
                    f"{error.strerror} (errno {error.errno})",
                    file=sys.stderr,
                )
                return 5
            lines.append(f"{offset}\t{device_offset}\t{contiguous}")
    finally:
        os.close(fd)

    if lines:
        sys.stdout.write("\n".join(lines) + "\n")
    return 0


def main(argv):
    try:
        path, stride, max_samples, offsets = parse_args(argv)
    except UsageError as error:
        print(f"log2phys: {error}", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 2

    if sys.platform != "darwin":
        print(
            "log2phys: F_LOG2PHYS_EXT is a Darwin/HFS-APFS fcntl; "
            f"this platform is {sys.platform!r}.",
            file=sys.stderr,
        )
        return 3

    try:
        return run(path, stride, max_samples, offsets)
    except OSError as error:
        print(f"log2phys: cannot open {path}: {error.strerror}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
