"""Archive identity must reject tampering, omissions and untracked additions."""
import importlib.util
import tempfile
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('source_snapshot', Path(__file__).with_name('gcp-source-snapshot.py'))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SourceSnapshot(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'implementation.ts').write_text('export const value = 1;\n')
        files = [snapshot.inspect_file(self.root, 'implementation.ts')]
        self.digest = snapshot.digest_files(files)
        self.manifest = {'files': files, 'snapshotSha256': self.digest, 'changedPaths': ['implementation.ts']}

    def test_exact_archive_passes(self):
        snapshot.verify_manifest(self.root, self.manifest, self.digest)

    def test_changed_bytes_fail(self):
        (self.root / 'implementation.ts').write_text('export const value = 2;\n')
        with self.assertRaisesRegex(ValueError, 'BYTES_MISMATCH'):
            snapshot.verify_manifest(self.root, self.manifest, self.digest)

    def test_extra_and_missing_files_fail(self):
        (self.root / 'untracked.ts').write_text('extra\n')
        with self.assertRaisesRegex(ValueError, 'INVENTORY_MISMATCH'):
            snapshot.verify_manifest(self.root, self.manifest, self.digest)
        (self.root / 'untracked.ts').unlink()
        (self.root / 'implementation.ts').unlink()
        with self.assertRaisesRegex(ValueError, 'INVENTORY_MISMATCH'):
            snapshot.verify_manifest(self.root, self.manifest, self.digest)

    def test_wrong_identity_and_secret_paths_fail(self):
        with self.assertRaisesRegex(ValueError, 'IDENTITY_MISMATCH'):
            snapshot.verify_manifest(self.root, self.manifest, '0' * 64)
        (self.root / '.env.local').write_text('not uploaded\n')
        with self.assertRaisesRegex(ValueError, 'Environment file refused'):
            snapshot.inspect_file(self.root, '.env.local')


if __name__ == '__main__':
    unittest.main()
