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

The call is therefore made from a **child process** (this script): a bad ABI or
a kernel refusal becomes a non-zero exit the caller falls back from, never a
crash of the verification run.  The child uses the stdlib ``fcntl`` module --
``fcntl.fcntl(fd, F_LOG2PHYS_EXT, packed_bytes)`` -- which issues the syscall
from C compiled against the real variadic prototype, so the arm64 rule that
anonymous arguments go on the stack is satisfied by construction on every
architecture.

An earlier revision marshalled the call through a Python FFI binding here. That
was not enough: a marshalled binding cannot express varargs, and without an
explicit ``argtypes`` declaration CPython treats ``fcntl`` as fixed-arity (it
only reaches ``ffi_prep_cif_var`` when ``argtypes`` is set and shorter than the
supplied argument list; see CPython's ``callproc.c``). On Apple arm64 libffi
gates the variadic register/stack split on ``aarch64_nfixedargs``, which the
fixed-arity path leaves ``0``; all three arguments go in registers while the
variadic callee ``va_arg``s a stack slot that was never written.  ``copyin``
then failed with ``EFAULT`` -- a clean helper exit instead of a Bun segfault,
but still no measurement.  The stdlib module is the correct fix because the
ABI-correct call is made in C, not marshalled by the runtime.

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

import errno
import fcntl
import itertools
import os
import struct
import sys

#: ``#define F_LOG2PHYS_EXT 65`` (XNU ``bsd/sys/fcntl.h``).
F_LOG2PHYS_EXT = 65

#: ``<Iqq`` = little-endian, standard sizes, no alignment padding = exactly
#: ``#pragma pack(4)``: 4 + 8 + 8 = 20 bytes at offsets 0, 4, 12, matching XNU
#: ``bsd/sys/fcntl.h``.  ``off_t`` is 64-bit on both Apple architectures.
L2P_FMT = "<Iqq"
L2P_SIZE = struct.calcsize(L2P_FMT)  # == 20

#: Guard the layout at import: if the struct sizes ever stopped matching the
#: kernel's ``#pragma pack(4)`` definition, fail loudly rather than emit
#: misaligned probes.  ``assert`` documents the intent; ``L2P_SIZE`` is the
#: value the assertion pins.
assert L2P_SIZE == 20, f"struct log2phys is {L2P_SIZE} bytes, expected 20"

#: ``--stride`` / ``--max-samples`` are clamped to a sane range so a typo in
#: CI cannot make the helper spin for hours or allocate unbounded memory.
MAX_SAMPLES_LIMIT = 10_000_000

USAGE = "usage: log2phys.py PATH --stride BYTES [--max-samples N] [--offset N ...]"


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


def query(fd, offset, stride):
    """One ``F_LOG2PHYS_EXT`` probe; returns ``(device_offset, contig_bytes)``.

    Uses the stdlib ``fcntl`` module rather than a marshalled FFI binding:
    stdlib makes the call from C compiled against the real
    ``int fcntl(int, int, ...)`` prototype, so Apple arm64's rule that anonymous
    arguments go on the **stack** is satisfied by construction on every arch.
    A marshalled binding cannot express varargs, and leaving ``argtypes`` unset
    makes CPython treat ``fcntl`` as fixed-arity -- the kernel then ``va_arg``s
    a stack slot that was never written and ``copyin`` fails with EFAULT.
    """
    # ``fcntl.fcntl`` returns the mutated arg buffer as a new ``bytes`` object
    # (see its docstring: "the return value of fcntl() is a bytes object of
    # that length, containing the resulting value put in the arg buffer by the
    # operating system").  No separate read-back buffer is needed.
    # in: flags, contigbytes, devoffset
    packed = struct.pack(L2P_FMT, 0, stride, offset)
    try:
        result = fcntl.fcntl(fd, F_LOG2PHYS_EXT, packed)
    except OSError as error:
        number = error.errno
        raise OSError(number, errno.errorcode.get(number, f"ERRNO_{number}")) from None
    _flags, contiguous, device_offset = struct.unpack(L2P_FMT, result)
    return device_offset, contiguous


def run(path, stride, max_samples, offsets):
    fd = os.open(path, os.O_RDONLY)
    try:
        file_size = os.fstat(fd).st_size

        lines = []
        for offset in sampled_offsets(file_size, stride, max_samples, offsets):
            try:
                device_offset, contiguous = query(fd, offset, stride)
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
