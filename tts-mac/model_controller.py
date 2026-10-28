"""Local-only model selection and generation coordination, using the bundled launcher."""
from datetime import datetime, timezone
from http.client import HTTPConnection, HTTPException
from pathlib import Path
import ipaddress
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mac_runtime import mac_process_matches


MODELS = (
    {'id': 'F16', 'label': 'F16 · 原始精度', 'filename': 'breeze-tts-2-f16.gguf', 'bytes': 6279630784},
    {'id': 'Q8', 'label': 'Q8_0 · 更省内存', 'filename': 'breeze-tts-2-q8_0.gguf', 'bytes': 3568844480},
)


def env_port(name, default):
    value = int(os.environ.get(name, str(default)))
    if not 1024 <= value <= 65535:
        raise ValueError(f'{name} must be a port between 1024 and 65535')
    return value


class ControlError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def validate_local_request(client_ip, host, origin, fetch_site, port, token=None, expected_token=None):
    """Guard control endpoints against non-loopback, DNS rebinding and cross-site requests."""
    try:
        if not ipaddress.ip_address(client_ip).is_loopback:
            raise ValueError('not loopback')
    except ValueError:
        raise ControlError(403, 'local_only', '此接口仅允许本机访问。')
    permitted = {f'127.0.0.1:{port}', f'localhost:{port}', f'[::1]:{port}'}
    host = (host or '').lower()
    if host not in permitted:
        raise ControlError(403, 'invalid_host', '请求地址与本地服务不一致。')
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme != 'http' or parsed.netloc.lower() != host or parsed.path or parsed.query or parsed.fragment:
            raise ControlError(403, 'invalid_origin', '请从本地 Breeze 页面执行此操作。')
    if (fetch_site or '').lower() == 'cross-site':
        raise ControlError(403, 'cross_site', '不允许其他网站调用本地模型管理。')
    if expected_token is not None and not secrets.compare_digest((token or '').encode('utf-8'), expected_token.encode('utf-8')):
        raise ControlError(403, 'invalid_token', '页面连接已更新，请刷新模型状态后重试。')


class ModelController:
    LEASE_SECONDS = 45

    def __init__(self, root, ui_port=8080, backend_port=8082, ws_port=8081,
                 runner=None, health_reader=None, process_verifier=None, clock=None):
        self.root = Path(root).resolve()
        self.ui_port, self.backend_port, self.ws_port = ui_port, backend_port, ws_port
        self.csrf_token = secrets.token_urlsafe(32)
        self._lock = threading.RLock()
        self._state, self._message = 'idle', ''
        self._target = None
        self._lease_id, self._lease_expiry = None, 0
        self._requests = 0
        self._thread = None
        self._clock = clock or time.monotonic
        self._runner = runner or self._run_launcher
        self._health_reader = health_reader or self._health
        self._process_verifier = process_verifier or mac_process_matches

    def _health(self):
        connection = HTTPConnection('127.0.0.1', self.backend_port, timeout=0.75)
        try:
            connection.request('GET', '/health')
            response = connection.getresponse()
            data = response.read(16384)
            health = json.loads(data)
            return response.status == 200 and health.get('status') == 'ok' and health.get('sample_rate') == 24000 and health.get('ws_port') == self.ws_port
        except (OSError, ValueError, HTTPException):
            return False
        finally:
            connection.close()

    def current_model(self):
        try:
            state = json.loads((self.root/'logs'/'server.pid').read_text(encoding='utf-8-sig'))
            if state.get('ports') != {'ui': self.ui_port, 'backend': self.backend_port, 'ws': self.ws_port}:
                return None
            executable = Path(state['executable']).resolve()
            permitted = {(self.root/'runtime'/f'breeze-{backend}'/'breeze-server').resolve()
                         for backend in ('metal', 'cpu')}
            if executable not in permitted or not executable.is_file():
                return None
            matched = next((model['id'] for model in MODELS if
                            os.path.normcase(str((self.root/'models'/model['filename']).resolve())) ==
                            os.path.normcase(str(Path(state['model']).resolve()))), None)
            if not matched or not self._process_verifier(state['processId'], executable, state['startedAtUtc']):
                return None
            return matched if self._health_reader() else None
        except (OSError, ValueError, KeyError, TypeError, StopIteration):
            return None

    def _expire_lease(self):
        if self._lease_id and self._clock() >= self._lease_expiry:
            self._lease_id, self._lease_expiry = None, 0

    def _busy(self):
        self._expire_lease()
        return bool(self._lease_id or self._requests)

    def snapshot(self):
        with self._lock:
            current = self.current_model()
            state, message = self._state, self._message
            if state == 'idle' and current is None:
                state, message = 'error', '模型尚未就绪，请选择模型并点击“切换模型”，或运行启动入口。'
            elif state == 'idle' and not message:
                message = '模型已就绪，可以生成语音。'
            models = []
            for model in MODELS:
                path = self.root/'models'/model['filename']
                present = path.is_file() and path.stat().st_size > 0
                models.append({**model, 'available': present, 'bytes': path.stat().st_size if present else model['bytes']})
            return {'models': models, 'current_model': current, 'state': state, 'message': message,
                    'target_model': self._target, 'generation_busy': self._busy(), 'csrf_token': self.csrf_token}

    def switch(self, model_id):
        with self._lock:
            model = next((entry for entry in MODELS if entry['id'] == model_id), None)
            if model is None:
                raise ControlError(400, 'invalid_model', '只支持选择 F16 或 Q8 模型。')
            if self._state == 'switching':
                raise ControlError(409, 'switching', '另一个模型切换正在进行，请稍候。')
            if self._busy():
                raise ControlError(409, 'generation_busy', '正在生成或处理参考声音，请完成或停止后再切换模型。')
            path = self.root/'models'/model['filename']
            if not path.is_file() or path.stat().st_size <= 0:
                raise ControlError(404, 'model_missing', '所选模型文件缺失，请完整解压便携包。')
            if self.current_model() == model_id:
                self._state, self._message, self._target = 'idle', '已在使用所选模型。', None
                return 200
            self._state, self._message, self._target = 'switching', '正在切换模型并预热，请稍候……', model_id
            self._thread = threading.Thread(target=self._perform_switch, args=(model_id,), daemon=True)
            self._thread.start()
            return 202

    def _perform_switch(self, model_id):
        try:
            result = self._runner(model_id)
            if result != 0:
                raise RuntimeError(f'启动入口退出码 {result}，请查看 logs/model-switch-*.log。')
            if self.current_model() != model_id:
                raise RuntimeError('启动入口已结束，但所选模型尚未通过健康检查，请查看 logs。')
            with self._lock:
                self._state, self._message = 'idle', '模型切换完成，可以生成语音。'
                self._target = None
        except Exception as error:
            with self._lock:
                self._state = 'error'
                self._message = '模型切换失败：' + str(error)
                self._target = None

    def _run_launcher(self, model_id):
        # Model IDs are checked before the worker starts; no user strings become shell code.
        script = self.root/'mac_runtime.py'
        if not script.is_file():
            raise RuntimeError('缺少本包 mac_runtime.py 启动脚本。')
        logs = self.root/'logs'
        logs.mkdir(exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')
        arguments = [sys.executable, '-I', str(script), 'start', '--model', model_id,
                     '--no-browser', '--backend-only']
        environment = os.environ.copy()
        environment.update(BREEZE_UI_PORT=str(self.ui_port), BREEZE_BACKEND_PORT=str(self.backend_port), BREEZE_WS_PORT=str(self.ws_port))
        with (logs/f'model-switch-{stamp}.log').open('wb') as log:
            with subprocess.Popen(arguments, cwd=str(self.root), env=environment, stdin=subprocess.DEVNULL,
                                  stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                  close_fds=True) as process:
                try:
                    return process.wait(timeout=960)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=10)
                    raise RuntimeError('启动等待超时；模型进程可能仍在加载，可用停止入口关闭。请查看 logs/model-switch-*.log。')

    def lease(self, lease_id=None):
        with self._lock:
            self._expire_lease()
            if lease_id:
                if lease_id != self._lease_id:
                    raise ControlError(409, 'lease_expired', '生成连接已失效，请重新生成。')
                self._lease_expiry = self._clock() + self.LEASE_SECONDS
            else:
                if self._state == 'switching' or self._busy():
                    raise ControlError(409, 'busy', '正在切换模型或生成语音，请稍候再试。')
                if self._state == 'error' or self.current_model() is None:
                    raise ControlError(409, 'not_ready', '模型尚未就绪，请先选择并加载模型。')
                self._lease_id = secrets.token_urlsafe(24)
                self._lease_expiry = self._clock() + self.LEASE_SECONDS
            return {'lease_id': self._lease_id, 'expires_in': self.LEASE_SECONDS}

    def release(self, lease_id):
        with self._lock:
            self._expire_lease()
            if self._lease_id and lease_id != self._lease_id:
                raise ControlError(409, 'invalid_lease', '无法结束另一个页面的生成连接。')
            self._lease_id, self._lease_expiry = None, 0
            return {'released': True}

    def begin_gpu_request(self):
        with self._lock:
            if self._state == 'switching':
                raise ControlError(409, 'switching', '模型正在切换，请稍后生成。')
            self._requests += 1

    def end_gpu_request(self):
        with self._lock:
            self._requests = max(0, self._requests - 1)
