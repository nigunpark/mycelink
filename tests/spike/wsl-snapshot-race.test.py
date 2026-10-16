"""Deterministic parent-symlink swap against root snapshot traversal."""
import importlib.util
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'wsl-codex-worker.py'
spec = importlib.util.spec_from_file_location('wsl_codex_worker', SCRIPT)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class SnapshotRaceTest(unittest.TestCase):
    def test_swapping_source_parent_after_lstat_cannot_copy_outside_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source = root / 'source'
            source.mkdir()
            allowed = source / 'allowed'
            allowed.mkdir()
            (allowed / 'data.txt').write_text('PUBLIC')
            outside = root / 'outside'
            outside.mkdir()
            (outside / 'data.txt').write_text('SECRET')
            dest = root / 'snapshot'
            dest.mkdir()
            original_open = os.open
            swapped = False
            def racing_open(path, flags, *args, **kwargs):
                nonlocal swapped
                if not swapped and (str(path) == str(allowed / 'data.txt') or path == 'data.txt'):
                    swapped = True
                    allowed.rename(root / 'parked')
                    allowed.symlink_to(outside, target_is_directory=True)
                return original_open(path, flags, *args, **kwargs)
            with patch.object(worker.os, 'open', side_effect=racing_open):
                worker.copied_tree(source, dest)
            self.assertTrue(swapped)
            self.assertEqual((dest / 'allowed' / 'data.txt').read_text(), 'PUBLIC')

if __name__ == '__main__':
    unittest.main()
