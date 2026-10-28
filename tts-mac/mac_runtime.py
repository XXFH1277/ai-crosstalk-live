"""Local macOS lifecycle, diagnostics and on-device acceptance checks (stdlib only)."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
from datetime import datetime, timezone
from http.client import HTTPConnection, HTTPException
import json
import math
import os
from pathlib import Path
import platform
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import wave

ROOT = Path(__file__).resolve().parent
MODEL_FILES = {
    'F16': ('breeze-tts-2-f16.gguf', 6279630784),
    'Q8': ('breeze-tts-2-q8_0.gguf', 3568844480),
}


class RuntimeFailure(RuntimeError):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def read_json(path):
    try:
        value = Path(path).read_text(encoding='utf-8-sig')
        result = json.loads(value)
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def env_port(name, default):
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        raise RuntimeFailure(f'{name} 必须是端口数字。')
    if not 1024 <= value <= 65535:
        raise RuntimeFailure(f'{name} 必须在 1024 到 65535 之间。')
    return value


class ProcBsdInfo(ctypes.Structure):
    # macOS <libproc.h>, PROC_PIDTBSDINFO. Fixed-width fields, sizeof == 136.
    _fields_ = [(name, ctypes.c_uint32) for name in (
        'pbi_flags', 'pbi_status', 'pbi_xstatus', 'pbi_pid', 'pbi_ppid',
        'pbi_uid', 'pbi_gid', 'pbi_ruid', 'pbi_rgid', 'pbi_svuid',
        'pbi_svgid', 'pbi_rfu_1')]
    _fields_ += [('pbi_comm', ctypes.c_char * 16), ('pbi_name', ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in (
        'pbi_nfiles', 'pbi_pgid', 'pbi_pjobc', 'e_tdev', 'e_tpgid')]
    _fields_ += [('pbi_nice', ctypes.c_int32), ('pbi_start_tvsec', ctypes.c_uint64),
                ('pbi_start_tvusec', ctypes.c_uint64)]


def mac_process_identity(pid):
    """Read executable plus kernel creation time, not a ps substring or PID alone."""
    if sys.platform != 'darwin':
        return None
    try:
        pid = int(pid)
        if pid <= 1:
            return None
        library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        library.proc_pidpath.argtypes = (ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32)
        library.proc_pidpath.restype = ctypes.c_int
        library.proc_pidinfo.argtypes = (ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                        ctypes.c_void_p, ctypes.c_int)
        library.proc_pidinfo.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(4096)
        if library.proc_pidpath(pid, buffer, len(buffer)) <= 0:
            return None
        info = ProcBsdInfo()
        if library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info):
            return None
        # A zombie is not an active owned server and cannot respond to signals.
        if info.pbi_pid != pid or info.pbi_status == 5 or info.pbi_start_tvusec >= 1000000:
            return None
        created = datetime.fromtimestamp(info.pbi_start_tvsec, timezone.utc).replace(
            microsecond=info.pbi_start_tvusec)
        return {'processId': pid, 'executable': str(Path(os.fsdecode(buffer.value)).resolve()),
                'startedAtUtc': created.isoformat(timespec='microseconds')}
    except (ValueError, TypeError, OSError, OverflowError):
        return None


def mac_process_matches(pid, executable, started_at):
    identity = mac_process_identity(pid)
    if not identity:
        return False
    try:
        expected = datetime.fromisoformat(str(started_at).replace('Z', '+00:00'))
        actual = datetime.fromisoformat(identity['startedAtUtc'])
        return (expected.tzinfo is not None and expected == actual and
                Path(identity['executable']).resolve() == Path(executable).resolve())
    except (ValueError, TypeError, OSError):
        return False


@contextmanager
def file_lock(path):
    """Nonblocking advisory lock released by the OS, including after crashes."""
    if sys.platform != 'darwin':
        raise RuntimeFailure('此运行入口仅适用于 Apple Silicon macOS。')
    import fcntl
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeFailure('另一个启动、停止或测试操作正在进行，请稍后重试。')
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def require_mac():
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        raise RuntimeFailure('请在 Apple Silicon Mac 上使用原生 ARM64 Python 运行本包，不能使用 Rosetta 或 Windows Python。')


def port_is_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def http_json(port, path, method='GET', body=None, token=None, timeout=5):
    connection = HTTPConnection('127.0.0.1', port, timeout=timeout)
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['X-Breeze-Token'] = token
    try:
        connection.request(method, path, None if body is None else json.dumps(body), headers)
        response = connection.getresponse()
        raw = response.read(1024 * 1024)
        data = json.loads(raw)
        if response.status >= 400:
            raise RuntimeFailure(f'HTTP {response.status}: {data}')
        return data
    finally:
        connection.close()


def inspect_wav(path):
    """Check real PCM frames; streamed RIFF headers may contain an unknown length."""
    with wave.open(str(path), 'rb') as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 24000:
            raise RuntimeFailure('测试音频不是预期的 24 kHz 单声道 16 位 WAV。')
        pcm = audio.readframes(24000 * 180)
    if len(pcm) < 2400 or len(pcm) % 2:
        raise RuntimeFailure('测试音频为空、过短或数据不完整。')
    samples = (value[0] for value in struct.iter_unpack('<h', pcm))
    rms = math.sqrt(sum(value * value for value in samples) / (len(pcm) // 2))
    if rms < 1.0:
        raise RuntimeFailure('测试音频只有静音，请查看模型日志。')
    return {'path': str(path), 'sample_rate': 24000, 'seconds': round(len(pcm) / 48000, 3),
            'rms_pcm16': round(rms, 3), 'bytes': Path(path).stat().st_size}


class BreezeRuntime:
    def __init__(self, root=ROOT, identity_reader=mac_process_identity, matcher=mac_process_matches):
        self.root = Path(root).resolve()
        self.logs = self.root / 'logs'
        self.ui_port = env_port('BREEZE_UI_PORT', 8080)
        self.ws_port = env_port('BREEZE_WS_PORT', 8081)
        self.backend_port = env_port('BREEZE_BACKEND_PORT', 8082)
        if len({self.ui_port, self.ws_port, self.backend_port}) != 3:
            raise RuntimeFailure('网页、WebSocket、语音服务三个端口必须互不相同。')
        self.identity_reader = identity_reader
        self.matcher = matcher

    @property
    def ports(self):
        return {'ui': self.ui_port, 'backend': self.backend_port, 'ws': self.ws_port}

    @property
    def url(self):
        return f'http://127.0.0.1:{self.ui_port}/'

    def configured(self, model=None, backend=None):
        config = read_json(self.root / 'config.json')
        if model is None:
            model = next((key for key, (name, _) in MODEL_FILES.items() if name == config.get('model')), 'Q8')
        if model not in MODEL_FILES:
            raise RuntimeFailure('只支持 F16 或 Q8 模型。')
        backend = backend or config.get('backend', 'metal')
        if backend not in ('metal', 'cpu'):
            raise RuntimeFailure('只支持 metal 或 cpu 运行后端。')
        return model, backend

    def pid_path(self, kind):
        return self.logs / f'{kind}.pid'

    def tracked(self, kind):
        state = read_json(self.pid_path(kind))
        try:
            executable = Path(state['executable']).resolve()
            if kind == 'server':
                permitted = {(self.root / 'runtime' / f'breeze-{backend}' / 'breeze-server').resolve()
                             for backend in ('metal', 'cpu')}
                if executable not in permitted:
                    return None
            elif kind == 'ui':
                if Path(state['script']).resolve() != self.root / 'ui_server.py':
                    return None
                # UI runtime may be bundled or a supported native Python. Never
                # accept a PID unless kernel path AND creation time both match.
            else:
                return None
            if self.matcher(state['processId'], executable, state['startedAtUtc']):
                return state
        except (KeyError, ValueError, TypeError, OSError):
            pass
        return None

    def health(self):
        try:
            data = http_json(self.backend_port, '/health', timeout=0.75)
            return (isinstance(data, dict) and data.get('status') == 'ok' and data.get('sample_rate') == 24000
                    and data.get('ws_port') == self.ws_port)
        except (OSError, ValueError, HTTPException, RuntimeFailure):
            return False

    def ui_health(self):
        try:
            data = http_json(self.ui_port, '/ui-health', timeout=0.75)
            return isinstance(data, dict) and data.get('status') == 'ok' and data.get('locale') == 'zh-CN'
        except (OSError, ValueError, HTTPException, RuntimeFailure):
            return False

    def assert_ui_idle(self, backend_only=False):
        owned = self.tracked('ui')
        if not owned:
            return
        if owned.get('ports') != self.ports:
            raise RuntimeFailure('本目录网页仍在使用另一组端口；请先运行本目录停止入口，再更改端口。')
        try:
            state = http_json(self.ui_port, '/local/models', timeout=3)
        except (OSError, ValueError, HTTPException):
            raise RuntimeFailure('本包网页进程运行中但状态不可读，请先停止本包再启动。')
        if state.get('generation_busy') or (state.get('state') == 'switching' and not backend_only):
            raise RuntimeFailure('网页正在生成或切换模型，请等待完成或先在网页停止生成。')

    def stop_one(self, kind):
        state = self.tracked(kind)
        if not state:
            # Stale/moved metadata is harmless. Never signal an unverified PID.
            return False
        pid, executable, created = state['processId'], state['executable'], state['startedAtUtc']
        if not self.matcher(pid, executable, created):
            return False
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 10
        while self.matcher(pid, executable, created) and time.monotonic() < deadline:
            time.sleep(0.1)
        if self.matcher(pid, executable, created):
            # Recheck identity immediately before the stronger signal as well.
            os.kill(pid, signal.SIGKILL)
            deadline = time.monotonic() + 5
            while self.matcher(pid, executable, created) and time.monotonic() < deadline:
                time.sleep(0.1)
        if self.matcher(pid, executable, created):
            raise RuntimeFailure(f'本包 {kind} 进程没有退出，未继续启动新服务。')
        # Avoid deleting a replacement record written by another process.
        if read_json(self.pid_path(kind)).get('startedAtUtc') == created:
            self.pid_path(kind).unlink(missing_ok=True)
        return True

    def spawn(self, kind, arguments, metadata):
        self.logs.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        stdout = self.logs / f'{kind}-{stamp}.stdout.log'
        stderr = self.logs / f'{kind}-{stamp}.stderr.log'
        environment = os.environ.copy()
        environment.update(BREEZE_UI_PORT=str(self.ui_port), BREEZE_WS_PORT=str(self.ws_port),
                           BREEZE_BACKEND_PORT=str(self.backend_port), PYTHONUNBUFFERED='1')
        with stdout.open('wb') as out, stderr.open('wb') as err:
            process = subprocess.Popen(arguments, cwd=self.root, env=environment,
                                       stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                       start_new_session=True, close_fds=True)
        identity = None
        for _ in range(40):
            if process.poll() is not None:
                raise RuntimeFailure(f'{kind} 提前退出（{process.returncode}），日志：{stderr}')
            identity = self.identity_reader(process.pid)
            if identity:
                break
            time.sleep(0.05)
        if not identity:
            # This Popen handle was just created by us, rather than loaded from a
            # pid file. poll() establishes it has not yet exited/reaped.
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    raise RuntimeFailure(f'无法确认新进程身份；终止等待超时。进程 {process.pid}，日志：{stderr}')
            raise RuntimeFailure(f'无法通过 macOS libproc 验证新进程，启动已中止。日志：{stderr}')
        state = {**identity, **metadata, 'ports': self.ports, 'stdout': str(stdout), 'stderr': str(stderr)}
        write_json(self.pid_path(kind), state)
        return process, state

    def ensure_ui(self):
        if self.tracked('ui'):
            if not self.ui_health():
                raise RuntimeFailure('本包网页进程正在运行但未就绪，请查看 logs/ui-*.stderr.log。')
            return
        if not port_is_free(self.ui_port):
            raise RuntimeFailure(f'网页端口 {self.ui_port} 被其他程序占用，未结束任何无关进程。')
        script = self.root / 'ui_server.py'
        if not script.is_file():
            raise RuntimeFailure('缺少 ui_server.py，请完整解压便携包。')
        process, state = self.spawn('ui', [sys.executable, '-I', '-u', str(script)], {'script': str(script)})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeFailure(f'网页进程提前退出，日志：{state["stderr"]}')
            if self.ui_health():
                return
            time.sleep(0.2)
        raise RuntimeFailure(f'网页启动超时；进程保留供诊断，日志：{state["stderr"]}')

    def start(self, model=None, backend=None, backend_only=False, no_browser=False):
        require_mac()
        model, backend = self.configured(model, backend)
        name, expected_size = MODEL_FILES[model]
        model_path = self.root / 'models' / name
        executable = self.root / 'runtime' / f'breeze-{backend}' / 'breeze-server'
        # Validate the replacement before stopping a working server.
        if not model_path.is_file() or model_path.stat().st_size != expected_size:
            raise RuntimeFailure(f'{model} 模型缺失或大小不正确，请重新完整解压并运行校验：{model_path}')
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise RuntimeFailure(f'尚未构建 {backend} 运行程序，请先执行一键部署：{executable}')
        with file_lock(self.logs / 'control.lock'):
            for kind in ('server', 'ui'):
                owned = self.tracked(kind)
                if owned and owned.get('ports') != self.ports:
                    raise RuntimeFailure('本目录进程仍在使用另一组端口；请先运行本目录停止入口，再更改端口。')
            self.assert_ui_idle(backend_only=backend_only)
            current = self.tracked('server')
            if current and Path(current.get('model', '')).resolve() == model_path and current.get('backend') == backend:
                if not self.health():
                    raise RuntimeFailure('本包模型进程正在运行但尚未就绪；请查看日志或先停止后重试。')
            else:
                if current:
                    self.stop_one('server')
                if not all(port_is_free(port) for port in (self.backend_port, self.ws_port)):
                    raise RuntimeFailure(f'语音端口 {self.backend_port}/{self.ws_port} 已被占用，未结束任何无关进程。')
                voices = self.root / 'voices'
                voices.mkdir(exist_ok=True)
                arguments = [str(executable), str(model_path), '--host', '127.0.0.1',
                             '--port', str(self.backend_port), '--ws-port', str(self.ws_port),
                             '--webui', '--voices-dir', str(voices)]
                if backend == 'cpu':
                    arguments.append('--cpu')
                process, state = self.spawn('server', arguments,
                                            {'model': str(model_path), 'backend': backend})
                seconds = 900 if backend == 'cpu' else 300
                print(f'正在加载 {model}，请求后端 {backend}，最多等待 {seconds} 秒……', flush=True)
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeFailure(f'模型进程提前退出（{process.returncode}）。日志：{state["stderr"]}')
                    if self.health():
                        break
                    time.sleep(1)
                else:
                    raise RuntimeFailure(f'{seconds} 秒内未就绪；进程保留供诊断，可用停止入口关闭。日志：{state["stderr"]}')
            config = read_json(self.root / 'config.json')
            config.update(model=name, backend=backend)
            write_json(self.root / 'config.json', config)
            if not backend_only:
                self.ensure_ui()
        print(f'Breeze TTS 2 已就绪：{self.url}\n模型：{model}；请求后端：{backend}', flush=True)
        if not no_browser and not backend_only:
            subprocess.run(['/usr/bin/open', self.url], check=False, timeout=10)

    def stop(self):
        require_mac()
        with file_lock(self.logs / 'control.lock'):
            stopped = [self.stop_one('server'), self.stop_one('ui')]
        print('本包语音服务与网页已停止。' if any(stopped) else '没有找到属于当前目录的运行进程。')

    def status(self):
        server, ui = self.tracked('server'), self.tracked('ui')
        return {'checked_at': utc_now(), 'root': str(self.root), 'platform': sys.platform,
                'architecture': platform.machine(), 'url': self.url,
                'configured': dict(zip(('model', 'backend'), self.configured())),
                'server': server, 'ui': ui,
                'backend_healthy': bool(server and server.get('ports') == self.ports and self.health()),
                'ui_healthy': bool(ui and ui.get('ports') == self.ports and self.ui_health())}

    def diagnose(self):
        result = self.status()
        result['python'] = {'executable': sys.executable, 'version': sys.version}
        result['backend_binary_present'] = {
            backend: (self.root / 'runtime' / f'breeze-{backend}' / 'breeze-server').is_file()
            for backend in ('metal', 'cpu')}
        result['models'] = {key: {'present': (self.root / 'models' / name).is_file(),
                                 'expected_bytes': size,
                                 'bytes': (self.root / 'models' / name).stat().st_size
                                 if (self.root / 'models' / name).is_file() else None}
                            for key, (name, size) in MODEL_FILES.items()}
        result['saved_voice_ids'] = sorted(path.stem for path in (self.root / 'voices').glob('*.breeze'))
        result['system'] = {}
        if sys.platform == 'darwin':
            for name, arguments in {'macos': ['/usr/bin/sw_vers'],
                                    'memory_bytes': ['/usr/sbin/sysctl', '-n', 'hw.memsize'],
                                    'gpu': ['/usr/sbin/system_profiler', 'SPDisplaysDataType', '-json']}.items():
                try:
                    run = subprocess.run(arguments, capture_output=True, text=True, timeout=20)
                    result['system'][name] = (run.stdout or run.stderr)[-20000:]
                except (OSError, subprocess.TimeoutExpired) as error:
                    result['system'][name] = str(error)
        result['recent_log_tails'] = {}
        if self.logs.is_dir():
            log_files = sorted(self.logs.glob('*.log'), key=lambda path: path.stat().st_mtime, reverse=True)[:8]
            for path in log_files:
                with path.open('rb') as handle:
                    handle.seek(max(0, path.stat().st_size - 12000))
                    result['recent_log_tails'][path.name] = handle.read().decode('utf-8', errors='replace')
        output = self.logs / 'diagnostics.json'
        write_json(output, result)
        print(f'诊断信息已保存：{output}')
        return result

    def switch_via_ui(self, model):
        owned_ui = self.tracked('ui')
        if not owned_ui or owned_ui.get('ports') != self.ports:
            raise RuntimeFailure('没有找到属于当前目录与端口的网页进程，未调用模型切换。')
        state = http_json(self.ui_port, '/local/models')
        token = state['csrf_token']
        http_json(self.ui_port, '/local/model', 'POST', {'model': model}, token)
        deadline = time.monotonic() + 960
        while time.monotonic() < deadline:
            state = http_json(self.ui_port, '/local/models')
            if state['state'] == 'error':
                raise RuntimeFailure(state.get('message', '网页模型切换失败。'))
            if state['state'] == 'idle' and state['current_model'] == model:
                return state
            time.sleep(1)
        raise RuntimeFailure('网页模型切换超过 960 秒。')

    def generate_test(self, model, voice_id):
        owned_ui, owned_server = self.tracked('ui'), self.tracked('server')
        if (not owned_ui or not owned_server or owned_ui.get('ports') != self.ports
                or owned_server.get('ports') != self.ports):
            raise RuntimeFailure('本目录的网页或模型进程已变化，未继续发送测试语音请求。')
        state = http_json(self.ui_port, '/local/models')
        token = state['csrf_token']
        lease = http_json(self.ui_port, '/local/generation/lease', 'POST', {}, token)
        stop_renewal = threading.Event()
        renewal_errors = []

        def renew():
            while not stop_renewal.wait(10):
                try:
                    http_json(self.ui_port, '/local/generation/lease', 'POST',
                              {'lease_id': lease['lease_id']}, token)
                except Exception as error:
                    renewal_errors.append(str(error))
                    return

        thread = threading.Thread(target=renew, daemon=True)
        thread.start()
        outputs = self.root / 'outputs'
        outputs.mkdir(exist_ok=True)
        output = outputs / f'mac-self-test-{model.lower()}.wav'
        # Direct backend audio avoids the UI proxy's shorter ordinary request
        # timeout on CPU. The UI lease still blocks other page operations.
        connection = HTTPConnection('127.0.0.1', self.backend_port, timeout=1800)
        start = time.monotonic()
        try:
            request = {'input': '你好，这是苹果电脑上的中文语音测试。', 'voice': voice_id,
                       'instructions': '自然清晰地讲解，普通话标准，语速适中。',
                       'response_format': 'wav', 'seed': 42, 'cfg_scale': 1,
                       'max_new_tokens': 160}
            connection.request('POST', '/v1/audio/speech', json.dumps(request), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeFailure(f'语音测试 HTTP {response.status}: {response.read(4096).decode("utf-8", errors="replace")}')
            total = 0
            with output.open('wb') as handle:
                while block := response.read1(65536):
                    total += len(block)
                    if total > 24_000 * 2 * 180 + 4096 or time.monotonic() - start > 1800:
                        raise RuntimeFailure('测试音频超过预期长度或合成超时。')
                    handle.write(block)
            if renewal_errors:
                raise RuntimeFailure('测试期间网页生成锁续期失败：' + renewal_errors[0])
            result = inspect_wav(output)
            result.update(model=model, voice_id=voice_id, generation_seconds=round(time.monotonic() - start, 3))
            return result
        finally:
            connection.close()
            stop_renewal.set()
            thread.join(6)
            try:
                http_json(self.ui_port, '/local/generation/lease', 'DELETE', {'lease_id': lease['lease_id']}, token)
            except (OSError, ValueError, HTTPException, RuntimeFailure):
                pass

    def self_test(self):
        require_mac()
        with file_lock(self.logs / 'self-test.lock'):
            original_model, original_backend = self.configured()
            report = {'started_at': utc_now(), 'status': 'running', 'checks': [],
                      'original_model': original_model, 'requested_backend': original_backend,
                      'note': 'Checks prove non-silent audio and lifecycle behavior, not subjective voice quality.'}
            path = self.logs / 'mac-self-test.json'
            write_json(path, report)
            failure = None
            started = False
            try:
                self.start(original_model, original_backend, no_browser=True)
                started = True
                self.assert_ui_idle()
                voice_list = http_json(self.backend_port, '/v1/voices')
                present = {voice['id'] for voice in voice_list if voice.get('saved')}
                expected = {voice.stem for voice in (self.root / 'voices').glob('*.breeze')}
                if not expected or expected - present:
                    raise RuntimeFailure('保存声音未全部加载：' + ', '.join(sorted(expected - present)) +
                                         '。请查看模型日志；必要时用包内参考音频和文字稿重建。')
                voice_id = 'zh_student_bright_01' if 'zh_student_bright_01' in present else sorted(present)[0]
                report['saved_voice_ids'] = sorted(present)
                for model in ('Q8', 'F16'):
                    self.switch_via_ui(model)
                    report['checks'].append(self.generate_test(model, voice_id))
                    write_json(path, report)
                self.switch_via_ui('Q8')
                report['switch_sequence'] = ['Q8', 'F16', 'Q8']
                report['status'] = 'passed'
            except Exception as error:
                report['status'], report['error'] = 'failed', str(error)
                failure = error
            finally:
                if started and self.tracked('ui'):
                    try:
                        self.switch_via_ui(original_model)
                        report['restored_model'] = original_model
                    except Exception as restore_error:
                        report['restore_error'] = str(restore_error)
                        report['status'] = 'failed'
                        failure = failure or restore_error
                report['finished_at'] = utc_now()
                write_json(path, report)
                self.diagnose()
            if failure:
                raise RuntimeFailure(f'Mac 自测未通过：{failure}。结果：{path}')
            print(f'Mac 自测通过：两个模型生成非静音中文 WAV、保存声音与双向切换检查均成功。\n结果：{path}')
            return report


def main(argv=None):
    parser = argparse.ArgumentParser(description='Breeze TTS 2 Apple Silicon local runtime')
    actions = parser.add_subparsers(dest='command', required=True)
    start = actions.add_parser('start', help='Start the selected model and local Chinese UI')
    start.add_argument('--model', choices=tuple(MODEL_FILES))
    start.add_argument('--backend', choices=('metal', 'cpu'))
    start.add_argument('--backend-only', action='store_true')
    start.add_argument('--no-browser', action='store_true')
    for command in ('stop', 'status', 'diagnose', 'self-test'):
        actions.add_parser(command)
    args = parser.parse_args(argv)
    try:
        runtime = BreezeRuntime()
        if args.command == 'start':
            runtime.start(args.model, args.backend, args.backend_only, args.no_browser)
        elif args.command == 'stop':
            runtime.stop()
        elif args.command == 'status':
            print(json.dumps(runtime.status(), ensure_ascii=False, indent=2))
        elif args.command == 'diagnose':
            runtime.diagnose()
        else:
            runtime.self_test()
        return 0
    except (RuntimeFailure, OSError, ValueError, HTTPException) as error:
        print(f'操作失败：{error}', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
