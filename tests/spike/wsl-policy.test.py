"""Generation/role/path policy over controller-owned worker transport reports."""
import importlib.util
import json
import pathlib
import os
import tempfile
import unittest

POLICY = pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'wsl-codex-policy.py'


def policy():
    spec = importlib.util.spec_from_file_location('codex_policy', POLICY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SealedProposalTest(unittest.TestCase):
    def test_consumer_verifies_generation_role_and_hash_before_accepting_submission(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            report = base / 'report.json'
            slot = base / 'sealed'
            p = policy()
            report.write_text(json.dumps({'claim': 'c1', 'generation': 'g1', 'role': 'reviewer',
                'source_files': 0, 'proposals': {}, 'submission': {'verdict': 'PASS'}}))
            p.seal(report, slot, claim='c1', generation='g1', role='reviewer', allowed_paths=set())
            self.assertEqual(p.read_submission(slot, claim='c1', generation='g1', role='reviewer'),
                             {'verdict': 'PASS'})
            for claim, generation, role in (('c2', 'g1', 'reviewer'), ('c1', 'g2', 'reviewer'),
                                            ('c1', 'g1', 'worker')):
                with self.assertRaises(ValueError):
                    p.read_submission(slot, claim=claim, generation=generation, role=role)
            (slot / 'verdict.json').write_text('{"verdict":"FORGED"}')
            with self.assertRaises(ValueError):
                p.read_submission(slot, claim='c1', generation='g1', role='reviewer')

    def test_reserved_result_names_cannot_hide_in_allowed_subdirectories(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            report = base / 'report.json'
            slot = base / 'sealed'
            for name in ('state/result.json', 'nested/verdict.json', 'state/_receipt.json'):
                report.write_text(json.dumps({'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                    'source_files': 0, 'proposals': {name: 'FORGED'}, 'submission': {}}))
                with self.assertRaises(ValueError, msg=name):
                    policy().seal(report, slot, claim='c1', generation='g1', role='worker',
                                  allowed_paths={name})
                self.assertFalse(slot.exists())

    def test_worker_result_and_reviewer_verdict_are_sealed_into_separate_slots(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            p = policy()
            for role, name in (('worker', 'result.json'), ('reviewer', 'verdict.json')):
                report = base / (role + '-report.json')
                slot = base / (role + '-sealed')
                report.write_text(json.dumps({'claim': 'c1', 'generation': 'g1', 'role': role,
                    'source_files': 0, 'proposals': {}, 'submission': {'role': role}}))
                receipt = p.seal(report, slot, claim='c1', generation='g1', role=role,
                                 allowed_paths=set())
                self.assertEqual(json.loads((slot / name).read_text()), {'role': role})
                self.assertEqual(receipt['role'], role)
                self.assertEqual(len(receipt['submission_sha256']), 64)
                self.assertFalse((slot / ('verdict.json' if role == 'worker' else 'result.json')).exists())
            target = base / 'target'
            target.mkdir()
            with self.assertRaises(ValueError):
                p.apply(base / 'reviewer-sealed', target, claim='c1', generation='g1', allowed_paths=set())

    def test_denies_mixed_paths_and_stale_generation_without_partial_stage(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            report = base / 'report.json'
            slot = base / 'sealed'
            data = {'claim': 'c1', 'generation': 'g1', 'role': 'worker', 'source_files': 1,
                    'proposals': {'allowed/file.txt': 'SAFE', 'state/result.json': 'FORGED'},
                    'submission': {'claim': 'c1'}}
            report.write_text(json.dumps(data))
            p = policy()
            with self.assertRaises(ValueError):
                p.seal(report, slot, claim='c1', generation='g1', role='worker',
                       allowed_paths={'allowed/file.txt'})
            self.assertFalse(slot.exists())
            data['proposals'].pop('state/result.json')
            report.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                p.seal(report, slot, claim='c1', generation='g2', role='worker',
                       allowed_paths={'allowed/file.txt'})
            self.assertFalse(slot.exists())
            receipt = p.seal(report, slot, claim='c1', generation='g1', role='worker',
                             allowed_paths={'allowed/file.txt'})
            self.assertEqual((slot / 'allowed' / 'file.txt').read_text(), 'SAFE')
            self.assertEqual(receipt['claim'], 'c1')
            self.assertEqual(receipt['generation'], 'g1')

    def test_reviewer_cannot_seal_worker_result_or_worker_reviewer_verdict(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            report = base / 'report.json'
            slot = base / 'sealed'
            p = policy()
            for role, proposal in [('reviewer', 'result.json'), ('worker', 'verdict.json')]:
                report.write_text(json.dumps({'claim': 'c1', 'generation': 'g1', 'role': role,
                    'source_files': 0, 'proposals': {proposal: '{}'}}))
                with self.assertRaises(ValueError):
                    p.seal(report, slot, claim='c1', generation='g1', role=role,
                           allowed_paths={'allowed/file.txt'})
                self.assertFalse(slot.exists())
    def test_atomic_apply_breaks_hardlink_alias_and_rejects_symlink_parent(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            report = base / 'report.json'
            slot = base / 'sealed'
            target = base / 'target'
            protected = base / 'protected.txt'
            target.mkdir()
            (target / 'allowed').mkdir()
            protected.write_text('ORIGINAL')
            os.link(protected, target / 'allowed' / 'file.txt')
            report.write_text(json.dumps({'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                'source_files': 0, 'proposals': {'allowed/file.txt': 'CHANGED'},
                'submission': {}}))
            p = policy()
            p.seal(report, slot, claim='c1', generation='g1', role='worker',
                   allowed_paths={'allowed/file.txt'})
            p.apply(slot, target, claim='c1', generation='g1', allowed_paths={'allowed/file.txt'})
            self.assertEqual((target / 'allowed' / 'file.txt').read_text(), 'CHANGED')
            self.assertEqual(protected.read_text(), 'ORIGINAL')
            (target / 'allowed' / 'file.txt').unlink()
            (target / 'allowed').rmdir()
            (target / 'allowed').symlink_to(base, target_is_directory=True)
            with self.assertRaises((ValueError, OSError)):
                p.apply(slot, target, claim='c1', generation='g1', allowed_paths={'allowed/file.txt'})
            self.assertEqual(protected.read_text(), 'ORIGINAL')
            self.assertFalse((base / 'file.txt').exists())
    @unittest.skipUnless(os.environ.get('MYCELINK_LIVE_WSL_WORKER') == '1', 'requires explicit WSL crossing opt-in')
    def test_windows_drive_hardlink_remains_unchanged_after_apply(self):
        scratch = '/mnt/c/Users/psh09/AppData/Local/hermes/cache/scratch'
        with tempfile.TemporaryDirectory() as linux, tempfile.TemporaryDirectory(dir=scratch) as windows:
            source = pathlib.Path(linux)
            target = pathlib.Path(windows) / 'target'
            target.mkdir()
            protected = pathlib.Path(windows) / 'protected.txt'
            protected.write_text('ORIGINAL')
            os.link(protected, target / 'alias.txt')
            report = source / 'report.json'
            report.write_text(json.dumps({'claim': 'c1', 'generation': 'g1', 'role': 'worker',
                'source_files': 0, 'proposals': {'alias.txt': 'NEW'}, 'submission': {}}))
            slot = source / 'sealed'
            p = policy()
            p.seal(report, slot, claim='c1', generation='g1', role='worker', allowed_paths={'alias.txt'})
            p.apply(slot, target, claim='c1', generation='g1', allowed_paths={'alias.txt'})
            self.assertEqual(protected.read_text(), 'ORIGINAL')
            self.assertEqual((target / 'alias.txt').read_text(), 'NEW')


if __name__ == '__main__':
    unittest.main()
