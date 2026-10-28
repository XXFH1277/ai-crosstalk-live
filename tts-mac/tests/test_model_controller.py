"""Model lifecycle and local-control HTTP tests; no models or GPU processes are started."""
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model_controller import ControlError, MODELS, ModelController, validate_local_request
import ui_server


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for name in ('models', 'runtime', 'logs'):
            (self.root/name).mkdir()
        (self.root/'runtime'/'breeze-metal').mkdir()
        self.exe = self.root/'runtime'/'breeze-metal'/'breeze-server'
        self.exe.write_bytes(b'test fixture only')
        for model in MODELS:
            (self.root/'models'/model['filename']).write_bytes(b'fixture')
        self.controller = ModelController(self.root, runner=lambda _: 0,
                                          health_reader=lambda: True, process_verifier=lambda *args: True)
        self.set_model('F16')

    def tearDown(self):
        if self.controller._thread:
            self.controller._thread.join(2)
        self.temp.cleanup()

    def set_model(self, model_id, executable=None):
        model = next(m for m in MODELS if m['id']==model_id)
        state = {'processId': 12345, 'executable': str(executable or self.exe),
                 'ports': {'ui': 8080, 'backend': 8082, 'ws': 8081},
                 'model': str(self.root/'models'/model['filename']), 'startedAtUtc': '2026-10-25T00:00:00Z'}
        (self.root/'logs'/'server.pid').write_text(json.dumps(state), encoding='utf-8-sig')

    def test_current_model_requires_this_package_process_and_health(self):
        self.assertEqual(self.controller.current_model(), 'F16')
        self.controller._health_reader = lambda: False
        self.assertIsNone(self.controller.current_model())
        self.assertEqual(self.controller.snapshot()['state'], 'error')
        self.controller._health_reader = lambda: True
        self.controller._process_verifier = lambda *args: False
        self.assertIsNone(self.controller.current_model())
        self.controller._process_verifier = lambda *args: True
        self.set_model('F16', self.root.parent/'unrelated.exe')
        self.assertIsNone(self.controller.current_model())

    def test_invalid_model_never_calls_launcher(self):
        launches = []
        self.controller._runner = lambda model: launches.append(model)
        for model in ('../models/evil', 'F16; whoami', 'q8', '', None, ['F16']):
            with self.assertRaises(ControlError) as error:
                self.controller.switch(model)
            self.assertEqual(error.exception.status, 400)
        self.assertEqual(launches, [])

    def test_missing_model_does_not_stop_existing_model(self):
        (self.root/'models'/MODELS[1]['filename']).unlink()
        with self.assertRaises(ControlError) as error:
            self.controller.switch('Q8')
        self.assertEqual(error.exception.status, 404)
        self.assertEqual(self.controller.current_model(), 'F16')

    def test_current_model_is_noop(self):
        self.assertEqual(self.controller.switch('F16'), 200)
        self.assertIsNone(self.controller._thread)

    def test_switch_is_async_and_excludes_concurrent_switch_and_generation(self):
        entered, finish = threading.Event(), threading.Event()
        def run(model):
            entered.set()
            finish.wait(2)
            self.set_model(model)
            return 0
        self.controller._runner = run
        try:
            self.assertEqual(self.controller.switch('Q8'), 202)
            self.assertTrue(entered.wait(1))
            self.assertEqual(self.controller.snapshot()['state'], 'switching')
            with self.assertRaises(ControlError):
                self.controller.switch('F16')
            with self.assertRaises(ControlError):
                self.controller.lease()
            with self.assertRaises(ControlError):
                self.controller.begin_gpu_request()
        finally:
            finish.set()
            self.controller._thread.join(2)
        self.assertEqual(self.controller.snapshot()['state'], 'idle')
        self.assertEqual(self.controller.snapshot()['current_model'], 'Q8')

    def test_failed_launcher_never_reports_target_ready(self):
        self.controller._runner = lambda _: 7
        self.controller.switch('Q8')
        self.controller._thread.join(2)
        status = self.controller.snapshot()
        self.assertEqual(status['state'], 'error')
        self.assertEqual(status['current_model'], 'F16')
        self.assertIn('7', status['message'])
        self.assertEqual(self.controller.switch('F16'), 200)
        self.assertEqual(self.controller.snapshot()['state'], 'idle')

    def test_exit_zero_without_correct_pid_is_failure(self):
        self.controller.switch('Q8')
        self.controller._thread.join(2)
        self.assertEqual(self.controller.snapshot()['state'], 'error')

    def test_lease_protects_switch_and_other_pages_until_release(self):
        first = self.controller.lease()
        with self.assertRaises(ControlError):
            self.controller.lease()
        with self.assertRaises(ControlError):
            self.controller.switch('Q8')
        with self.assertRaises(ControlError):
            self.controller.release('another-page')
        self.assertEqual(self.controller.lease(first['lease_id'])['lease_id'], first['lease_id'])
        # The operation holding the lease can still use the ordinary HTTP API.
        self.controller.begin_gpu_request()
        self.controller.end_gpu_request()
        self.controller.release(first['lease_id'])
        self.assertFalse(self.controller.snapshot()['generation_busy'])

    def test_abandoned_lease_expires(self):
        now = [10.0]
        self.controller._clock = lambda: now[0]
        first = self.controller.lease()
        now[0] += self.controller.LEASE_SECONDS+1
        second = self.controller.lease()
        self.assertNotEqual(first['lease_id'], second['lease_id'])

    def test_http_inflight_request_protects_switch_even_without_lease(self):
        self.controller.begin_gpu_request()
        with self.assertRaises(ControlError):
            self.controller.switch('Q8')
        self.controller.end_gpu_request()
        self.assertFalse(self.controller.snapshot()['generation_busy'])


class SecurityTests(unittest.TestCase):
    def test_local_origin_and_csrf_are_required_for_mutation(self):
        valid = dict(client_ip='127.0.0.1',host='127.0.0.1:8080',origin='http://127.0.0.1:8080',
                     fetch_site='same-origin',port=8080,token='secret',expected_token='secret')
        validate_local_request(**valid)
        for changes in ({'client_ip':'192.168.1.5'}, {'host':'evil.example:8080'},
                        {'origin':'https://evil.example'}, {'origin':'null'},
                        {'origin':'http://127.0.0.1:8080/evil'}, {'fetch_site':'cross-site'},
                        {'token':None}, {'token':'wrong'}, {'token':'非ASCII'}):
            with self.subTest(changes=changes), self.assertRaises(ControlError) as error:
                validate_local_request(**(valid|changes))
            self.assertEqual(error.exception.status, 403)


class HttpTests(ControllerTests):
    def setUp(self):
        super().setUp()
        class QuietHandler(ui_server.Handler):
            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.port = self.server.server_address[1]
        self.patches = [patch.object(ui_server, 'UI_PORT', self.port),
                        patch.object(ui_server, 'CONTROLLER', self.controller)]
        for item in self.patches:
            item.start()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        for item in reversed(self.patches):
            item.stop()
        super().tearDown()

    def call(self, method, path, payload=None, headers=None):
        connection = HTTPConnection('127.0.0.1', self.port, timeout=2)
        request_headers = {'Content-Type':'application/json'}
        if headers:
            request_headers.update(headers)
        connection.request(method, path, None if payload is None else json.dumps(payload), request_headers)
        response = connection.getresponse()
        data = response.read()
        result = response.status, json.loads(data)
        connection.close()
        return result

    def test_status_and_control_authentication(self):
        status, data = self.call('GET','/local/models')
        self.assertEqual(status, 200)
        self.assertEqual(data['current_model'], 'F16')
        self.assertEqual(len(data['models']), 2)
        status, _ = self.call('POST','/local/model',{'model':'F16'})
        self.assertEqual(status, 403)
        token = {'X-Breeze-Token':data['csrf_token']}
        status, result = self.call('POST','/local/model',{'model':'F16'},token)
        self.assertEqual(status, 200)
        self.assertEqual(result['state'], 'idle')
        status, _ = self.call('POST','/local/model',{'model':'F16'},token|{'Origin':'https://evil.example'})
        self.assertEqual(status, 403)
        status, _ = self.call('GET','/local/models',headers={'Host':'evil.example'})
        self.assertEqual(status, 403)

    def test_http_lease_roundtrip_and_invalid_model(self):
        token = {'X-Breeze-Token':self.controller.csrf_token}
        status, data = self.call('POST','/local/generation/lease',{},token)
        self.assertEqual(status, 200)
        status, _ = self.call('POST','/local/model',{'model':'Q8'},token)
        self.assertEqual(status, 409)
        status, _ = self.call('DELETE','/local/generation/lease',{'lease_id':data['lease_id']},token)
        self.assertEqual(status, 200)
        status, _ = self.call('POST','/local/model',{'model':'../../escape'},token)
        self.assertEqual(status, 400)
        status, _ = self.call('POST','/local/model',[],token)
        self.assertEqual(status, 400)


if __name__ == '__main__':
    unittest.main()
