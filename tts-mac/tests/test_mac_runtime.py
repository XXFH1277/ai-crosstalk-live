"""Portable control tests: no Mac binary is executed and no real PID is signalled."""
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
import ctypes
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mac_runtime as runtime


class ProcessIdentityTests(unittest.TestCase):
    def test_libproc_structure_has_expected_abi_layout(self):
        self.assertEqual(ctypes.sizeof(runtime.ProcBsdInfo), 136)
        self.assertEqual(runtime.ProcBsdInfo.pbi_start_tvsec.offset, 120)
        self.assertEqual(runtime.ProcBsdInfo.pbi_start_tvusec.offset, 128)

    def test_non_mac_never_calls_native_process_api(self):
        with patch.object(runtime.sys, 'platform', 'win32'), patch.object(runtime.ctypes, 'CDLL') as native:
            self.assertIsNone(runtime.mac_process_identity(123))
            self.assertFalse(runtime.mac_process_matches(123, '/a', '2026-10-25T00:00:00Z'))
        native.assert_not_called()

    def test_reads_kernel_path_and_exact_creation_time(self):
        library = Mock()
        library.proc_pidpath = Mock()
        library.proc_pidinfo = Mock()
        expected_path = str(Path('/Applications/Breeze/runtime/breeze-metal/breeze-server').resolve())
        def path_call(pid, buffer, count):
            buffer.value = os.fsencode(expected_path)
            return len(buffer.value)
        def info_call(pid, flavor, argument, pointer, size):
            info = ctypes.cast(pointer, ctypes.POINTER(runtime.ProcBsdInfo)).contents
            info.pbi_pid, info.pbi_status = pid, 2
            info.pbi_start_tvsec, info.pbi_start_tvusec = 1792886400, 123456
            return size
        library.proc_pidpath.side_effect = path_call
        library.proc_pidinfo.side_effect = info_call
        with patch.object(runtime.sys, 'platform', 'darwin'), patch.object(runtime.ctypes, 'CDLL', return_value=library):
            actual = runtime.mac_process_identity(123)
        expected_created = datetime.fromtimestamp(1792886400, timezone.utc).replace(microsecond=123456)
        self.assertEqual(actual, {'processId': 123, 'executable': expected_path,
                                  'startedAtUtc': expected_created.isoformat(timespec='microseconds')})

    def test_match_rejects_pid_reuse_other_path_and_naive_timestamp(self):
        identity = {'processId': 123, 'executable': str(Path('/a/server').resolve()),
                    'startedAtUtc': '2026-10-25T00:00:00.123456+00:00'}
        with patch.object(runtime, 'mac_process_identity', return_value=identity):
            self.assertTrue(runtime.mac_process_matches(123, '/a/server', '2026-10-25T00:00:00.123456Z'))
            self.assertFalse(runtime.mac_process_matches(123, '/a/server', '2026-10-25T00:00:00.123455Z'))
            self.assertFalse(runtime.mac_process_matches(123, '/b/server', identity['startedAtUtc']))
            self.assertFalse(runtime.mac_process_matches(123, '/a/server', '2026-10-25T00:00:00.123456'))

    def test_mac_gate_rejects_rosetta_and_non_mac(self):
        for system, machine in [('win32', 'AMD64'), ('darwin', 'x86_64'), ('linux', 'arm64')]:
            with self.subTest(system=system, machine=machine), patch.object(runtime.sys, 'platform', system), \
                 patch.object(runtime.platform, 'machine', return_value=machine):
                with self.assertRaises(runtime.RuntimeFailure):
                    runtime.require_mac()
        with patch.object(runtime.sys, 'platform', 'darwin'), patch.object(runtime.platform, 'machine', return_value='arm64'):
            runtime.require_mac()


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='Breeze 中文 test ')
        self.root = Path(self.temp.name).resolve()
        for directory in ('runtime/breeze-metal', 'runtime/breeze-cpu', 'models', 'logs', 'voices'):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        self.matcher = Mock(return_value=True)
        self.runtime = runtime.BreezeRuntime(self.root, matcher=self.matcher)
        self.server = self.root / 'runtime' / 'breeze-metal' / 'breeze-server'
        self.server.write_bytes(b'not executable: fixture only')

    def tearDown(self):
        self.temp.cleanup()

    def record_server(self, executable=None):
        record = {'processId': 12345, 'executable': str(executable or self.server),
                  'startedAtUtc': '2026-10-25T00:00:00.123456Z',
                  'model': str(self.root / 'models' / runtime.MODEL_FILES['Q8'][0]), 'backend': 'metal'}
        runtime.write_json(self.runtime.pid_path('server'), record)
        return record

    def test_config_defaults_and_remembered_backend(self):
        self.assertEqual(self.runtime.configured(), ('Q8', 'metal'))
        runtime.write_json(self.root / 'config.json', {'model': runtime.MODEL_FILES['F16'][0], 'backend': 'cpu'})
        self.assertEqual(self.runtime.configured(), ('F16', 'cpu'))
        self.assertEqual(self.runtime.configured('Q8', 'metal'), ('Q8', 'metal'))
        with self.assertRaises(runtime.RuntimeFailure):
            self.runtime.configured('F16; kill')

    def test_invalid_ports_fail_before_touching_processes(self):
        for values in ({'BREEZE_UI_PORT': '22'}, {'BREEZE_UI_PORT': 'text'},
                       {'BREEZE_UI_PORT': '8181', 'BREEZE_WS_PORT': '8181'}):
            with self.subTest(values=values), patch.dict(os.environ, values):
                with self.assertRaises(runtime.RuntimeFailure):
                    runtime.BreezeRuntime(self.root)

    def test_unrelated_runtime_path_never_signalled(self):
        self.record_server(self.root / 'runtime' / 'unrelated' / 'breeze-server')
        with patch.object(runtime.os, 'kill') as kill:
            self.assertFalse(self.runtime.stop_one('server'))
        self.matcher.assert_not_called()
        kill.assert_not_called()

    def test_stale_pid_never_signalled(self):
        self.record_server()
        self.matcher.return_value = False
        with patch.object(runtime.os, 'kill') as kill:
            self.assertFalse(self.runtime.stop_one('server'))
        kill.assert_not_called()

    def test_identity_rechecked_immediately_before_signal(self):
        self.record_server()
        self.matcher.side_effect = [True, False]
        with patch.object(runtime.os, 'kill') as kill:
            self.assertFalse(self.runtime.stop_one('server'))
        kill.assert_not_called()

    def test_owned_terminated_process_removes_only_own_record(self):
        record = self.record_server()
        self.matcher.side_effect = [True, True, False, False, False]
        with patch.object(runtime.os, 'kill') as kill:
            self.assertTrue(self.runtime.stop_one('server'))
        kill.assert_called_once_with(record['processId'], runtime.signal.SIGTERM)
        self.assertFalse(self.runtime.pid_path('server').exists())

    def test_moved_directory_record_does_not_stop_old_copy(self):
        self.record_server(self.root.parent / 'other-copy' / 'runtime' / 'breeze-metal' / 'breeze-server')
        self.assertIsNone(self.runtime.tracked('server'))
        self.matcher.assert_not_called()

    def test_missing_replacement_model_does_not_stop_working_model(self):
        self.record_server()
        with patch.object(runtime, 'require_mac'), patch.object(self.runtime, 'stop_one') as stop:
            with self.assertRaises(runtime.RuntimeFailure):
                self.runtime.start('F16', 'metal', no_browser=True)
        stop.assert_not_called()

    def test_missing_cpu_build_does_not_stop_working_model(self):
        model = self.root / 'models' / runtime.MODEL_FILES['Q8'][0]
        model.write_bytes(b'fixture')
        with patch.dict(runtime.MODEL_FILES, {'Q8': (model.name, 7)}), \
             patch.object(runtime, 'require_mac'), patch.object(self.runtime, 'stop_one') as stop:
            with self.assertRaises(runtime.RuntimeFailure):
                self.runtime.start('Q8', 'cpu', no_browser=True)
        stop.assert_not_called()

    def test_cli_model_switch_refuses_active_generation(self):
        with patch.object(self.runtime, 'tracked', return_value={'processId': 123, 'ports': self.runtime.ports}), \
             patch.object(runtime, 'http_json', return_value={'generation_busy': True, 'state': 'idle'}):
            with self.assertRaises(runtime.RuntimeFailure):
                self.runtime.assert_ui_idle(backend_only=True)

    def test_internal_switch_accepts_own_ui_switching_state_only(self):
        with patch.object(self.runtime, 'tracked', return_value={'processId': 123, 'ports': self.runtime.ports}), \
             patch.object(runtime, 'http_json', return_value={'generation_busy': False, 'state': 'switching'}):
            self.runtime.assert_ui_idle(backend_only=True)
            with self.assertRaises(runtime.RuntimeFailure):
                self.runtime.assert_ui_idle(backend_only=False)

    def test_changed_ports_do_not_query_an_unrelated_ui(self):
        old_ports = dict(self.runtime.ports, ui=19000)
        with patch.object(self.runtime, 'tracked', return_value={'processId': 123, 'ports': old_ports}), \
             patch.object(runtime, 'http_json') as request:
            with self.assertRaises(runtime.RuntimeFailure):
                self.runtime.assert_ui_idle()
            with self.assertRaises(runtime.RuntimeFailure):
                self.runtime.switch_via_ui('F16')
        request.assert_not_called()

    def test_failed_initial_start_does_not_switch_unrelated_ui_during_restore(self):
        with patch.object(runtime, 'require_mac'), patch.object(runtime, 'file_lock', return_value=nullcontext()), \
             patch.object(self.runtime, 'start', side_effect=runtime.RuntimeFailure('port occupied')), \
             patch.object(self.runtime, 'switch_via_ui') as switch, patch.object(self.runtime, 'diagnose'):
            with self.assertRaises(runtime.RuntimeFailure):
                self.runtime.self_test()
        switch.assert_not_called()
        report = runtime.read_json(self.root / 'logs' / 'mac-self-test.json')
        self.assertEqual(report['status'], 'failed')
        self.assertIn('port occupied', report['error'])

    def test_self_test_checks_both_models_and_restores_original(self):
        runtime.write_json(self.root / 'config.json', {'model': runtime.MODEL_FILES['F16'][0], 'backend': 'metal'})
        (self.root / 'voices' / 'speaker.breeze').write_bytes(b'fixture')
        with patch.object(runtime, 'require_mac'), patch.object(runtime, 'file_lock', return_value=nullcontext()), \
             patch.object(self.runtime, 'start'), patch.object(self.runtime, 'assert_ui_idle'), \
             patch.object(runtime, 'http_json', return_value=[{'id': 'speaker', 'saved': True}]), \
             patch.object(self.runtime, 'switch_via_ui') as switch, patch.object(self.runtime, 'diagnose'), \
             patch.object(self.runtime, 'tracked', return_value={'processId': 123}), \
             patch.object(self.runtime, 'generate_test', side_effect=lambda model, voice: {'model': model, 'voice': voice}):
            result = self.runtime.self_test()
        self.assertEqual([call.args[0] for call in switch.call_args_list], ['Q8', 'F16', 'Q8', 'F16'])
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['restored_model'], 'F16')
        self.assertEqual([item['model'] for item in result['checks']], ['Q8', 'F16'])

    def test_incompatible_saved_voice_fails_instead_of_designing_new_voice(self):
        (self.root / 'voices' / 'speaker.breeze').write_bytes(b'fixture')
        with patch.object(runtime, 'require_mac'), patch.object(runtime, 'file_lock', return_value=nullcontext()), \
             patch.object(self.runtime, 'start'), patch.object(self.runtime, 'assert_ui_idle'), \
             patch.object(runtime, 'http_json', return_value=[]), patch.object(self.runtime, 'switch_via_ui'), \
             patch.object(self.runtime, 'diagnose'), patch.object(self.runtime, 'tracked', return_value={'processId': 123}), \
             patch.object(self.runtime, 'generate_test') as generate:
            with self.assertRaises(runtime.RuntimeFailure):
                self.runtime.self_test()
        generate.assert_not_called()


class AudioAndEntryTests(unittest.TestCase):
    def test_wav_validation_requires_real_nonsilent_frames(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'sample.wav'
            with wave.open(str(path), 'wb') as audio:
                audio.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
                audio.writeframes(struct.pack('<h', 1000) * 24000)
            result = runtime.inspect_wav(path)
            self.assertEqual(result['seconds'], 1)
            self.assertEqual(result['rms_pcm16'], 1000)
            with wave.open(str(path), 'wb') as audio:
                audio.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
                audio.writeframes(bytes(48000))
            with self.assertRaises(runtime.RuntimeFailure):
                runtime.inspect_wav(path)

    def test_isolated_cli_import_works_from_other_working_directory(self):
        with tempfile.TemporaryDirectory() as cwd:
            result = subprocess.run([sys.executable, '-I', str(runtime.ROOT / 'mac_runtime.py'), '--help'],
                                    cwd=cwd, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('self-test', result.stdout)


if __name__ == '__main__':
    unittest.main()
