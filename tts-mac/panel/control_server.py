"""Tiny localhost control service for the desktop Breeze TTS panel.

Listens on 127.0.0.1 only and requires the token stored in panel/token, so
other web pages cannot start or stop the model. All real work is delegated to
mac_runtime.py, which keeps its own process identity checks.
"""
from __future__ import annotations

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time

PANEL = Path(__file__).resolve().parent
ROOT = PANEL.parent
sys.path.insert(0, str(ROOT))
import mac_runtime  # noqa: E402

PORT = int(os.environ.get('BREEZE_PANEL_PORT', '8079'))
TOKEN = (PANEL / 'token').read_text(encoding='utf-8').strip()
ALLOWED_HOSTS = {f'127.0.0.1:{PORT}', f'localhost:{PORT}'}
OPEN_TARGETS = {'outputs': ROOT / 'outputs', 'voices': ROOT / 'voices', 'logs': ROOT / 'logs',
                'recordings': ROOT / '录音', 'root': ROOT}


class Job:
    """At most one start/stop command runs at a time."""

    def __init__(self):
        self.lock = threading.Lock()
        self.action = None
        self.running = False
        self.lines = []
        self.exit_code = None
        self.finished_at = None

    def snapshot(self):
        with self.lock:
            return {'action': self.action, 'running': self.running, 'exit_code': self.exit_code,
                    'finished_at': self.finished_at, 'output': self.lines[-80:]}

    def launch(self, action, arguments):
        with self.lock:
            if self.running:
                return False
            self.action, self.running, self.lines, self.exit_code, self.finished_at = action, True, [], None, None
        threading.Thread(target=self._run, args=(arguments,), daemon=True).start()
        return True

    def _log(self, line):
        with self.lock:
            self.lines.append(line)

    def _attempt(self, command):
        start = len(self.lines)
        try:
            process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, bufsize=1)
            for line in process.stdout:
                self._log(line.rstrip('\n'))
            return process.wait(), self.lines[start:]
        except OSError as error:
            self._log(f'无法运行：{error}')
            return -1, []

    def _run(self, arguments):
        command = [sys.executable, '-I', '-u', str(ROOT / 'mac_runtime.py'), *arguments]
        code, output = self._attempt(command)
        # Right after a stop, closed sockets linger in TIME_WAIT for ~30 s and
        # mac_runtime's strict port check reports them as occupied. Retry while
        # nothing is actually listening; a real foreign listener still fails.
        deadline = time.monotonic() + 75
        while (arguments[0] == 'start' and code != 0 and any('占用' in line for line in output)
               and not ports_have_listener() and time.monotonic() < deadline):
            self._log('端口刚释放，系统仍在回收连接，3 秒后自动重试……')
            time.sleep(3)
            code, output = self._attempt(command)
        with self.lock:
            self.running, self.exit_code = False, code
            self.finished_at = datetime.now(timezone.utc).isoformat()


JOB = Job()


def ports_have_listener():
    """True if a process other than this package's own UI/server listens on its ports."""
    runtime = mac_runtime.BreezeRuntime(ROOT)
    ports = []
    if not runtime.tracked('ui'):
        ports.append(runtime.ui_port)
    if not runtime.tracked('server'):
        ports += [runtime.backend_port, runtime.ws_port]
    for port in ports:
        try:
            socket.create_connection(('127.0.0.1', port), timeout=0.5).close()
            return True
        except ConnectionRefusedError:
            continue
        except OSError:
            return True
    return False


def process_rss_mb(pid):
    try:
        run = subprocess.run(['/bin/ps', '-o', 'rss=', '-p', str(pid)], capture_output=True, text=True, timeout=3)
        return round(int(run.stdout.strip()) / 1024, 1)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def runtime_status():
    runtime = mac_runtime.BreezeRuntime(ROOT)
    status = runtime.status()
    model, backend = status['configured']['model'], status['configured']['backend']
    server = status.get('server') or {}
    result = {
        'url': status['url'],
        'configured': {'model': model, 'backend': backend},
        'backend_healthy': status['backend_healthy'],
        'ui_healthy': status['ui_healthy'],
        'server_running': bool(status.get('server')),
        'ui_running': bool(status.get('ui')),
        'binaries': {name: (ROOT / 'runtime' / f'breeze-{name}' / 'breeze-server').is_file()
                     for name in ('metal', 'cpu')},
        'server': None,
    }
    if server:
        result['server'] = {
            'model': Path(server.get('model', '')).name,
            'backend': server.get('backend'),
            'started_at': server.get('startedAtUtc'),
            'pid': server.get('processId'),
            'rss_mb': process_rss_mb(server.get('processId')),
        }
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = 'BreezePanel/1.0'

    def log_message(self, format, *args):
        pass

    def _headers(self, status, length=0, content_type='application/json; charset=utf-8'):
        self.send_response(status)
        # Only the desktop file:// page (Origin: null) or same-origin pages need CORS.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Panel-Token')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(length))
        self.end_headers()

    def _json(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self._headers(status, len(body))
        self.wfile.write(body)

    def _authorized(self):
        if self.headers.get('Host') not in ALLOWED_HOSTS:
            self._json(403, {'error': 'bad host'})
            return False
        if not hmac.compare_digest(self.headers.get('X-Panel-Token', ''), TOKEN):
            self._json(401, {'error': '令牌不正确，请重新运行面板安装脚本。'})
            return False
        return True

    def _body(self):
        length = min(int(self.headers.get('Content-Length') or 0), 4096)
        if not length:
            return {}
        try:
            value = json.loads(self.rfile.read(length))
            return value if isinstance(value, dict) else {}
        except ValueError:
            return {}

    def do_OPTIONS(self):
        self._headers(204)

    def do_GET(self):
        if not self._authorized():
            return
        if self.path == '/status':
            try:
                self._json(200, {'runtime': runtime_status(), 'job': JOB.snapshot(), 'time': time.time()})
            except Exception as error:  # status must never take the panel down
                self._json(200, {'runtime': None, 'error': str(error), 'job': JOB.snapshot()})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not self._authorized():
            return
        body = self._body()
        if self.path == '/start':
            # mac_runtime opens the voice UI in the default browser once ready.
            arguments = ['start']
            if body.get('model') in ('F16', 'Q8'):
                arguments += ['--model', body['model']]
            if body.get('backend') in ('metal', 'cpu'):
                arguments += ['--backend', body['backend']]
            started = JOB.launch('start', arguments)
            self._json(202 if started else 409, {'ok': started, 'job': JOB.snapshot()})
        elif self.path == '/stop':
            started = JOB.launch('stop', ['stop'])
            self._json(202 if started else 409, {'ok': started, 'job': JOB.snapshot()})
        elif self.path == '/open':
            target = OPEN_TARGETS.get(body.get('target'))
            if target is None:
                self._json(400, {'error': 'unknown target'})
                return
            target.mkdir(exist_ok=True)
            subprocess.run(['/usr/bin/open', str(target)], check=False, timeout=10)
            self._json(200, {'ok': True})
        else:
            self._json(404, {'error': 'not found'})


def main():
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Breeze panel control service on 127.0.0.1:{PORT}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
