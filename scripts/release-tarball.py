#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Usertools, Inc.
"""Writes the tarball that npm publishes. See docs/releasing.md.

  release-tarball.py assemble --input <build.tgz> --output <publish.tgz> --mtime <seconds>
                              --root <name>=<file> [--root <name>=<file> ...]

The release's publish job runs this; scripts/release.sh calls it once per package. The job
holds the credentials that publish, and the build job, which ran dependency code, made the
input. So the input is DATA, and nothing of it reaches npm except member bytes that pass every
rule below. The output is written here, from scratch:

- Every root file (package.json, README.md, LICENSE, NOTICE, and any root file the manifest's
  "files" names) comes from a --root file, which scripts/release.sh writes from the verified
  release commit's git blobs. The input's root members are checked and then DISCARDED.
- Every other file comes from an input member under package/dist/ that passes the name rule.
  Only its validated name and its bytes are kept: each output header is new (fixed mode,
  owner and time; no extended record but the path, and that only when a name needs it).
- The output is verified against what was meant (every path, every byte, every header field),
  and then extracted by the system's tar, which must succeed without one warning.

The input is read by a child process (this file, "parse"), which cannot write a byte to any
file (RLIMIT_FSIZE 0) and has a CPU limit, a wall-clock limit, and on Linux a memory limit.
It decompresses into a bounded buffer, requires one complete gzip member and nothing after
it, and parses the tar headers itself, counting every physical header. Any failure, of a rule
or of the process, refuses.
"""

import argparse
import base64
import hashlib
import io
import os
import re
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import zlib

MIB = 1024 * 1024

# The caps. The largest package today (usertrust) packs to about 330 files and 2.7 MB unpacked,
# with a longest member name of 69 bytes and 4 levels below package/.
MAX_COMPRESSED = 16 * MIB  # the build tarball as read from disk
MAX_DECOMPRESSED = 64 * MIB  # the tar stream inside it
MAX_HEADERS = 4096  # physical tar headers, extended headers included
MAX_FILE = 8 * MIB  # any one member
MAX_TOTAL = 48 * MIB  # all members together
MAX_PATH = 200  # bytes in a member name, "package/" included
MAX_COMPONENT = 100  # bytes in one component of it
MAX_DEPTH = 16  # components after "package/"
MAX_EXTENDED = 1024  # the body of one PAX extended header
# The parser process.
PARSE_SECONDS = 120  # wall clock
PARSE_CPU_SECONDS = 60
PARSE_MEMORY = 512 * MIB  # address space; enforced where the platform supports it (Linux)

BLOCK = 512
ZERO_BLOCK = bytes(BLOCK)
# The only gzip header the output carries: no name, no comment, no extra field, mtime 0.
GZIP_HEADER = b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff"

COMPONENT = r"[A-Za-z0-9._@-]+"
PAYLOAD_NAME = re.compile(rf"package/dist/{COMPONENT}(?:/{COMPONENT})*")
ROOT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
# Names npm or Node treat specially, refused as any component of a payload path, in any case.
FORBIDDEN = frozenset({"package.json", "node_modules", "npm-shrinkwrap.json", "binding.gyp"})
# Root members an npm tarball always may carry. The manifest's "files" adds the rest.
FIXED_ROOTS = ("package.json", "README.md", "LICENSE", "NOTICE")

# PAX keys: "path" names the member and "size" must agree with the header (npm's own packer
# writes both, and mtime). These others carry nothing the parser uses, and are ignored. Every
# other key ("linkpath", "hdrcharset", "GNU.sparse.*", vendor keys, ...) refuses.
INPUT_IGNORED_KEYS = frozenset(
    {"comment", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname"}
)

TYPE_NAMES = {
    b"1": "hard link",
    b"2": "symbolic link",
    b"3": "character device",
    b"4": "block device",
    b"6": "FIFO",
    b"7": "contiguous file",
    b"g": "global extended header",
    b"L": "GNU long name",
    b"K": "GNU long link name",
    b"S": "GNU sparse file",
}


class Refused(Exception):
    pass


def show(value):
    """A name or value from the input, printable on one line (no control characters)."""
    text = ascii(value)
    return text if len(text) <= 160 else text[:157] + "..."


# ── Reading (the child process) ──


def gunzip(compressed):
    """The bytes of exactly one complete gzip member, at most MAX_DECOMPRESSED of them."""
    inflater = zlib.decompressobj(wbits=31)
    out = bytearray()
    pending = compressed
    while True:
        try:
            chunk = inflater.decompress(pending, MAX_DECOMPRESSED - len(out) + 1)
        except zlib.error as e:
            raise Refused(f"not a valid gzip stream ({show(str(e))})") from None
        out += chunk
        if len(out) > MAX_DECOMPRESSED:
            raise Refused(f"decompresses to more than {MAX_DECOMPRESSED} bytes")
        if inflater.eof:
            break
        pending = inflater.unconsumed_tail
        if not pending:
            raise Refused("the gzip stream is truncated")
    if inflater.unused_data:
        raise Refused("data follows the gzip stream (trailing bytes, or a second gzip member)")
    return out


def octal(field, what):
    if field[:1] and field[0] & 0x80:
        raise Refused(f"{what} uses the base-256 encoding")
    digits = bytes(field).split(b"\0", 1)[0].strip(b" ")
    if not digits or not all(0x30 <= c <= 0x37 for c in digits):
        raise Refused(f"{what} is not an octal number")
    return int(digits, 8)


def cstring(field):
    return bytes(field).split(b"\0", 1)[0]


def pax_records(body, allowed, ignored):
    """A PAX extended header's records, parsed by their length prefixes."""
    records = {}
    i = 0
    while i < len(body):
        space = body.find(b" ", i, i + 21)
        if space <= i or not body[i:space].isdigit() or body[i : i + 1] == b"0":
            raise Refused("an extended header record has no valid length")
        end = i + int(body[i:space])
        if end > len(body) or body[end - 1 : end] != b"\n":
            raise Refused("an extended header record does not end where its length says")
        key, eq, value = bytes(body[space + 1 : end - 1]).partition(b"=")
        if not eq or not key:
            raise Refused("an extended header record has no key")
        try:
            k = key.decode("ascii")
            v = value.decode("utf-8")
        except UnicodeDecodeError:
            raise Refused("an extended header record is not valid text") from None
        if k in records:
            raise Refused(f"the extended header key {show(k)} appears twice")
        if k.startswith("GNU.sparse."):
            raise Refused(f"a sparse file (extended header key {show(k)}) is not accepted")
        if k in allowed:
            if k == "size" and not value.isdigit():
                raise Refused("the extended header size is not a number")
            records[k] = int(v) if k == "size" else v
        elif k in ignored:
            records[k] = None
        else:
            raise Refused(f"the extended header key {show(k)} is not accepted")
        i = end
    return records


def parse_tar(tar, allowed_keys, ignored_keys):
    """Yields (kind, name, data, header) for each file ("file") and directory ("dir").

    Every physical header counts against MAX_HEADERS, and each extended header's body is
    checked against MAX_EXTENDED before it is parsed. Member sizes count against MAX_FILE and
    MAX_TOTAL before their bytes are taken.
    """
    offset = 0
    headers = 0
    total = 0
    extended = None
    while True:
        header = bytes(tar[offset : offset + BLOCK])
        if len(header) < BLOCK:
            raise Refused("the tar stream ends without its end-of-archive marker")
        if header == ZERO_BLOCK:
            if bytes(tar[offset + BLOCK : offset + 2 * BLOCK]) != ZERO_BLOCK:
                raise Refused("the end-of-archive marker is incomplete")
            if extended is not None:
                raise Refused("an extended header has no member after it")
            if tar.count(b"\0", offset) != len(tar) - offset:
                raise Refused("data follows the end-of-archive marker")
            return
        headers += 1
        if headers > MAX_HEADERS:
            raise Refused(f"more than {MAX_HEADERS} tar headers")
        summed = sum(header[:148]) + 8 * 0x20 + sum(header[156:])
        if octal(header[148:156], "a header checksum") != summed:
            raise Refused("a tar header's checksum is wrong")
        if header[257:263] != b"ustar\0" or header[263:265] != b"00":
            raise Refused("a tar header is not POSIX ustar")
        kind = header[156:157]
        size = octal(header[124:136], "a member size")
        start = offset + BLOCK
        offset = start + (size + BLOCK - 1) // BLOCK * BLOCK
        ustar_name = cstring(header[0:100]).decode("latin-1")
        prefix = cstring(header[345:500]).decode("latin-1")
        if prefix:
            ustar_name = f"{prefix}/{ustar_name}"
        if kind == b"x":
            if extended is not None:
                raise Refused("two extended headers in a row")
            if size > MAX_EXTENDED:
                raise Refused(f"an extended header of {size} bytes (the cap is {MAX_EXTENDED})")
            if start + size > len(tar):
                raise Refused("an extended header runs past the end of the tar stream")
            extended = pax_records(tar[start : start + size], allowed_keys, ignored_keys)
            continue
        if kind not in (b"0", b"\0", b"5"):
            what = TYPE_NAMES.get(kind, f"member of type {show(kind)}")
            raise Refused(
                f"{show(ustar_name)} is a {what}; only regular files and directories are accepted"
            )
        name = ustar_name
        if extended is not None:
            if "size" in extended and extended["size"] != size:
                raise Refused(f"{show(ustar_name)}: the extended header's size disagrees")
            name = extended.get("path") or name
            extended = None
        if kind == b"5":
            if size != 0:
                raise Refused(f"directory {show(name)} has a size")
            yield "dir", name, b"", header
            continue
        if size > MAX_FILE:
            raise Refused(f"{show(name)} is {size} bytes (the cap for one file is {MAX_FILE})")
        total += size
        if total > MAX_TOTAL:
            raise Refused(f"the members total more than {MAX_TOTAL} bytes")
        if start + size > len(tar):
            raise Refused(f"{show(name)} runs past the end of the tar stream")
        yield "file", name, bytes(tar[start : start + size]), header


def ancestors(name):
    parts = name.split("/")
    return ["/".join(parts[:i]) for i in range(1, len(parts))]


class Classifier:
    """Decides each input member: a payload file, a root file (discarded), or a refusal."""

    def __init__(self, roots):
        self.roots = frozenset(roots)
        self.seen = set()  # every effective name, compared without case
        self.files = set()
        self.dirs = set()  # explicit and implied directories

    def classify(self, kind, name):
        if kind == "dir" and name.endswith("/"):
            name = name[:-1]
        if len(name.encode("utf-8")) > MAX_PATH:
            raise Refused(f"{show(name)} is longer than {MAX_PATH} bytes")
        parts = name.split("/")
        if any(len(p.encode("utf-8")) > MAX_COMPONENT for p in parts):
            raise Refused(f"{show(name)} has a component longer than {MAX_COMPONENT} bytes")
        if len(parts) - 1 > MAX_DEPTH:
            raise Refused(f"{show(name)} is more than {MAX_DEPTH} levels deep")
        if kind == "dir" and name in ("package", "package/dist"):
            role = None
        elif name.startswith("package/dist/"):
            if not PAYLOAD_NAME.fullmatch(name):
                raise Refused(f"{show(name)} is not a permitted name (letters, digits, . _ @ -)")
            for part in parts[1:]:
                if part.startswith(".") or part.endswith("."):
                    raise Refused(f"{show(name)} has a component that begins or ends with a dot")
                if part.lower() in FORBIDDEN:
                    raise Refused(
                        f"{show(name)} names {show(part)}, which npm or Node treats specially"
                    )
            role = "payload" if kind == "file" else None
        elif name.startswith("package/") and len(parts) == 2:
            if kind != "file" or parts[1] not in self.roots:
                raise Refused(f"{show(name)} is not a root file this package ships")
            role = "root"
        else:
            raise Refused(f"{show(name)} is outside package/ or package/dist/")
        key = name.lower()
        if key in self.seen:
            raise Refused(f"{show(name)} appears twice (names are compared without case)")
        self.seen.add(key)
        # (A directory entry with a file's name is the same effective name, refused above.)
        if kind == "file" and key in self.dirs:
            raise Refused(f"{show(name)} is a file and also a directory")
        for parent in ancestors(key):
            if parent in self.files:
                raise Refused(f"{show(name)} is inside {show(parent)}, which is a file")
            self.dirs.add(parent)
        (self.files if kind == "file" else self.dirs).add(key)
        return role, name


def read_input(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Refused("the build tarball is not a regular file")
        chunks = []
        size = 0
        while size <= MAX_COMPRESSED:
            chunk = os.read(fd, MAX_COMPRESSED + 1 - size)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
    finally:
        os.close(fd)
    data = b"".join(chunks)
    if len(data) > MAX_COMPRESSED:
        raise Refused(f"the build tarball is more than {MAX_COMPRESSED} bytes")
    return data


def child_main(argv):
    """parse <build.tgz> <root name>...: writes the accepted members to stdout, framed."""
    out = sys.stdout.buffer
    try:
        classifier = Classifier(argv[1:])
        tar = gunzip(read_input(argv[0]))
        for kind, name, data, _header in parse_tar(tar, {"path", "size"}, INPUT_IGNORED_KEYS):
            role, name = classifier.classify(kind, name)
            raw = name.encode("ascii")
            if role == "payload":
                out.write(b"P" + struct.pack(">IQ", len(raw), len(data)) + raw + data)
            elif role == "root":
                out.write(b"R" + struct.pack(">I", len(raw)) + raw)
        out.write(b"E")
        out.flush()
    except Refused as e:
        print(f"::error::release-tarball: {e}", file=sys.stderr)
        return 1
    except Exception as e:  # any failure of the parser is a refusal
        print(f"::error::release-tarball: the parser failed: {show(repr(e))}", file=sys.stderr)
        return 1
    return 0


# ── Running the child ──


def _limit_child():
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (PARSE_CPU_SECONDS, PARSE_CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))  # it writes no file
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (PARSE_MEMORY, PARSE_MEMORY))


def run_parser(input_path, roots):
    """The child's framed output, read into at most a bounded buffer, or a refusal."""
    import selectors

    if not sys.executable:
        raise Refused("cannot find the python interpreter to run the parser")
    cap = MAX_TOTAL + MAX_HEADERS * (13 + MAX_PATH) + 1
    argv = [sys.executable, "-I", "-S", os.path.abspath(__file__), "parse", input_path, *roots]
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={},
            close_fds=True,
            preexec_fn=_limit_child,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise Refused(f"could not start the parser under its limits ({show(str(e))})") from None
    out_fd = proc.stdout.fileno()
    err_fd = proc.stderr.fileno()
    bufs = {out_fd: bytearray(), err_fd: bytearray()}
    sel = selectors.DefaultSelector()
    for fd in bufs:
        sel.register(fd, selectors.EVENT_READ)
    deadline = time.monotonic() + PARSE_SECONDS
    try:
        while sel.get_map():
            left = deadline - time.monotonic()
            if left <= 0:
                raise Refused(f"the parser ran longer than {PARSE_SECONDS} seconds")
            for key, _ in sel.select(left):
                chunk = os.read(key.fd, 1 << 16)
                if not chunk:
                    sel.unregister(key.fd)
                    continue
                bufs[key.fd] += chunk
                if len(bufs[key.fd]) > cap:
                    raise Refused("the parser's output exceeds its bound")
        try:
            status = proc.wait(max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise Refused("the parser did not exit") from None
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        sel.close()
        proc.stdout.close()
        proc.stderr.close()
    errors = bytes(bufs[err_fd]).decode("utf-8", "replace")
    if errors:
        sys.stderr.write(errors if errors.endswith("\n") else errors + "\n")
    if status != 0:
        how = f"was killed by signal {-status}" if status < 0 else f"exited {status}"
        raise Refused(f"the parser {how}; the build tarball is refused")
    return bytes(bufs[out_fd])


def unframe(stream):
    """(payload, root names) from the child's framed output, which must end with its marker."""
    payload = []
    roots = []
    i = 0
    while True:
        kind = stream[i : i + 1]
        if kind == b"E" and i + 1 == len(stream):
            return payload, roots
        if kind == b"P" and i + 13 <= len(stream):
            name_len, data_len = struct.unpack(">IQ", stream[i + 1 : i + 13])
            name_end = i + 13 + name_len
            end = name_end + data_len
            if end > len(stream):
                break
            payload.append((stream[i + 13 : name_end].decode("ascii"), stream[name_end:end]))
            i = end
        elif kind == b"R" and i + 5 <= len(stream):
            (name_len,) = struct.unpack(">I", stream[i + 1 : i + 5])
            end = i + 5 + name_len
            if end > len(stream):
                break
            roots.append(stream[i + 5 : end].decode("ascii"))
            i = end
        else:
            break
    raise Refused("the parser's output is malformed")


# ── Writing and verifying (the parent process) ──


def write_tar(members, mtime):
    """A tar of (name, bytes), sorted, every header made here from the name and size alone.

    USTAR when every name fits its fields, which is always so for the names npm packs today:
    a USTAR header has no extended records at all, so a reader has nothing to interpret but
    fixed fields. Otherwise PAX, whose only record is the "path" that tarfile adds for a name
    that does not fit; no record is ever copied from the input.
    """

    def build(fmt):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w", format=fmt) as tf:
            for name, data in members:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = mtime
                info.type = tarfile.REGTYPE
                tf.addfile(info, io.BytesIO(data))
        return buf.getvalue()

    try:
        return build(tarfile.USTAR_FORMAT)
    except ValueError:
        return build(tarfile.PAX_FORMAT)


def gzip_bytes(raw):
    """gzip with a fixed header (no name, mtime 0), so the same tar always gives the same bytes."""
    deflater = zlib.compressobj(9, zlib.DEFLATED, -15)
    body = deflater.compress(raw) + deflater.flush()
    return GZIP_HEADER + body + struct.pack("<II", zlib.crc32(raw), len(raw) & 0xFFFFFFFF)


def verify(gz, members, mtime):
    """The written tarball holds exactly <members>, in order, under the fixed header fields."""
    if gz[:10] != GZIP_HEADER:
        raise Refused("the assembled gzip header is not the fixed one")
    tar = gunzip(gz)
    found = []
    for kind, name, data, header in parse_tar(tar, {"path"}, frozenset()):
        fields = (
            kind,
            header[156:157],
            octal(header[100:108], "mode"),
            octal(header[108:116], "uid"),
            octal(header[116:124], "gid"),
            octal(header[136:148], "mtime"),
            cstring(header[157:257]),
            cstring(header[265:297]),
            cstring(header[297:329]),
        )
        if fields != ("file", b"0", 0o644, 0, 0, mtime, b"", b"", b""):
            raise Refused(f"the assembled header for {show(name)} is not the fixed one")
        found.append((name, data))
    if [n for n, _ in found] != [n for n, _ in members]:
        raise Refused("the assembled tarball does not hold exactly the expected paths")
    for (name, data), (_, want) in zip(found, members):
        if data != want:
            raise Refused(f"the assembled bytes of {show(name)} differ")


def extract_check(path, members):
    """The system's tar extracts it, silently, into exactly the expected files."""
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run(
            ["tar", "-xzf", path, "-C", tmp],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=PARSE_SECONDS,
        )
        if r.returncode != 0 or r.stdout or r.stderr:
            said = (r.stdout + r.stderr).decode("utf-8", "replace").strip()
            raise Refused(f"tar -x did not extract it cleanly (exit {r.returncode}): {show(said)}")
        found = {}
        for top, dirs, files in os.walk(tmp):
            for entry in dirs + files:
                full = os.path.join(top, entry)
                if os.path.islink(full):
                    raise Refused(f"extraction made a link: {show(entry)}")
            for entry in files:
                full = os.path.join(top, entry)
                with open(full, "rb") as f:
                    found[os.path.relpath(full, tmp).replace(os.sep, "/")] = f.read()
        if found != dict(members):
            raise Refused("tar -x produced other files, or other bytes, than were assembled")


def read_root(spec):
    name, eq, path = spec.partition("=")
    special = name.lower() == "dist" or (name.lower() in FORBIDDEN and name != "package.json")
    if not eq or not ROOT_NAME.fullmatch(name) or special:
        raise Refused(f"--root {show(spec)} is not <root file name>=<path>")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_FILE:
            raise Refused(f"--root {show(name)} is not a regular file of at most {MAX_FILE} bytes")
        with os.fdopen(os.dup(fd), "rb") as f:
            return name, f.read(MAX_FILE + 1)
    finally:
        os.close(fd)


def assemble(argv):
    p = argparse.ArgumentParser(prog="release-tarball.py assemble")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--mtime", required=True, type=int)
    p.add_argument("--root", action="append", default=[])
    args = p.parse_args(argv)
    if not 0 <= args.mtime < 8**11:
        raise Refused("--mtime is out of range")
    roots = dict(read_root(spec) for spec in args.root)
    if len({n.lower() for n in roots}) != len(args.root) or "package.json" not in roots:
        raise Refused("the root files must include package.json, each named once")
    allowed = sorted(set(FIXED_ROOTS) | set(roots))
    payload, _discarded = unframe(run_parser(args.input, allowed))
    members = sorted([(f"package/{n}", b) for n, b in roots.items()] + payload)
    names = [n for n, _ in members]
    if len(set(names)) != len(names):
        raise Refused("the assembled member names are not unique")
    gz = gzip_bytes(write_tar(members, args.mtime))
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(gz)
            f.flush()
            os.fsync(f.fileno())
        with open(args.output, "rb") as f:
            written = f.read()
        if written != gz:
            raise Refused("the assembled tarball on disk is not what was written")
        verify(written, members, args.mtime)
        extract_check(args.output, members)
    except BaseException:
        os.unlink(args.output)
        raise
    digest = base64.b64encode(hashlib.sha512(written).digest()).decode("ascii")
    print(
        f"assembled {os.path.basename(args.output)}: {len(roots)} root files from the release"
        f" commit, {len(payload)} files from the build's dist/, sha512-{digest}"
    )


def main(argv):
    if argv[:1] == ["parse"] and len(argv) >= 2:
        return child_main(argv[1:])
    if argv[:1] == ["assemble"]:
        try:
            assemble(argv[1:])
        except Refused as e:
            print(f"::error::release-tarball: {e}", file=sys.stderr)
            return 1
        except Exception as e:  # any other failure is a refusal too
            print(f"::error::release-tarball: {show(repr(e))}", file=sys.stderr)
            return 1
        return 0
    print(
        "usage: release-tarball.py assemble --input F --output F --mtime N --root NAME=F ...",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
