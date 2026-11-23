# SPDX-License-Identifier: AGPL-3.0-only
"""Archive admission for scripts/studio-adapter-check.py: bounded expansion and coded refusals before any sandbox runs."""
import gzip
import importlib.util
import io
import tarfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("studio_adapter_check", Path(__file__).with_name("studio-adapter-check.py"))
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


def tar_gz(members):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for name, data in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue())


class AdapterArchiveTest(unittest.TestCase):
    def refuses(self, archive, code):
        with self.assertRaises(ValueError) as caught:
            CHECK.adapter_source(archive)
        self.assertEqual(str(caught.exception), code)

    def test_reads_the_single_adapter_source(self):
        source = b"export const check = () => ({ ok: true });\n"
        archive = tar_gz([("adapter/README.md", b"notes"), ("adapter/src/adapter.mts", source)])
        self.assertEqual(CHECK.adapter_source(archive), source)

    def test_stops_expansion_at_the_limit_before_parsing_members(self):
        # Compresses to a few KiB, within ARCHIVE_LIMIT, but expands past EXPANDED_LIMIT.
        bomb = gzip.compress(b"\0" * (CHECK.EXPANDED_LIMIT + 1))
        self.assertLess(len(bomb), CHECK.ARCHIVE_LIMIT)
        self.refuses(bomb, "ARCHIVE_LIMIT")

    def test_refuses_archives_that_are_not_gzip_tar(self):
        self.refuses(b"not an archive", "ARCHIVE_INVALID")
        self.refuses(tar_gz([("adapter/src/adapter.mts", b"x")])[:-12], "ARCHIVE_INVALID")
        self.refuses(gzip.compress(b"plain text, not a tar stream" * 40), "ARCHIVE_INVALID")

    def test_refuses_missing_or_duplicate_sources(self):
        self.refuses(tar_gz([("adapter/src/other.mts", b"x")]), "ADAPTER_SOURCE_NOT_FOUND")
        self.refuses(tar_gz([("a/src/adapter.mts", b"x"), ("b/src/adapter.mts", b"y")]), "ADAPTER_SOURCE_INVALID")


if __name__ == "__main__":
    unittest.main()
