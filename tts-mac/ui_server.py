"""Serve the local Chinese UI and relay HTTP APIs to the Breeze runtime."""
from http import HTTPStatus
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

# The bundled Python runs isolated (-I); import only this package's sibling module.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from model_controller import ControlError, ModelController, env_port, validate_local_request

ROOT = Path(__file__).resolve().parent
UI_PORT = env_port('BREEZE_UI_PORT', 8080)
BACKEND_PORT = env_port('BREEZE_BACKEND_PORT', 8082)
WS_PORT = env_port('BREEZE_WS_PORT', 8081)
CONTROLLER = ModelController(ROOT, UI_PORT, BACKEND_PORT, WS_PORT)
ASSETS = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
    '/style.css': ('style.css', 'text/css; charset=utf-8'),
    '/model-selector.js': ('model-selector.js', 'text/javascript; charset=utf-8'),
}
HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate',
               'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'BreezeChineseUI/1.0'

    def send_bytes(self, status, data, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def send_json(self, status, data):
        self.send_bytes(status, json.dumps(data, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def guard_local(self, mutation=False):
        validate_local_request(self.client_address[0], self.headers.get('Host'),
                               self.headers.get('Origin'), self.headers.get('Sec-Fetch-Site'), UI_PORT,
                               self.headers.get('X-Breeze-Token'), CONTROLLER.csrf_token if mutation else None)

    def control_body(self):
        if self.headers.get('Transfer-Encoding'):
            raise ControlError(400, 'invalid_body', '模型管理请求不支持分块正文。')
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise ControlError(400, 'invalid_length', '请求长度无效。')
        if not 0 < length <= 4096:
            raise ControlError(413, 'body_too_large', '模型管理请求必须在 4096 字节以内。')
        if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
            raise ControlError(415, 'invalid_content_type', '请使用 JSON 请求。')
        try:
            data = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            raise ControlError(400, 'invalid_json', '请求 JSON 格式无效。')
        if not isinstance(data, dict):
            raise ControlError(400, 'invalid_json', '请求必须是 JSON 对象。')
        return data

    def local_control(self, path):
        if path == '/local/models' and self.command in ('GET', 'HEAD'):
            self.send_json(200, CONTROLLER.snapshot())
            return
        self.guard_local(mutation=True)
        if path == '/local/model' and self.command == 'POST':
            data = self.control_body()
            status = CONTROLLER.switch(data.get('model'))
            self.send_json(status, CONTROLLER.snapshot())
            return
        if path == '/local/generation/lease' and self.command in ('POST', 'DELETE'):
            data = self.control_body()
            lease_id = data.get('lease_id')
            if lease_id is not None and not isinstance(lease_id, str):
                raise ControlError(400, 'invalid_lease', '生成连接标识必须是字符串。')
            if self.command == 'POST':
                self.send_json(200, CONTROLLER.lease(lease_id))
            elif not lease_id:
                raise ControlError(400, 'invalid_lease', '缺少生成连接标识。')
            else:
                self.send_json(200, CONTROLLER.release(lease_id))
            return
        raise ControlError(404, 'not_found', '没有这个本地管理接口。')

    def request_body(self):
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            chunks = []
            while True:
                line = self.rfile.readline(8192)
                size = int(line.split(b';', 1)[0].strip(), 16)
                if size == 0:
                    while self.rfile.readline(8192) not in (b'\r\n', b'\n', b''):
                        pass
                    return b''.join(chunks)
                data = self.rfile.read(size)
                if len(data) != size or self.rfile.read(2) != b'\r\n':
                    raise ValueError('Incomplete request body')
                chunks.append(data)
        size = int(self.headers.get('Content-Length', '0'))
        if size < 0:
            raise ValueError('Invalid Content-Length')
        data = self.rfile.read(size) if size else None
        if data is not None and len(data) != size:
            raise ValueError('Incomplete request body')
        return data

    def relay(self):
        # CPU fallback can take substantially longer to produce its first chunk.
        upstream = HTTPConnection('127.0.0.1', BACKEND_PORT, timeout=1800)
        started = False
        tracked = False
        try:
            path = urlsplit(self.path).path
            if self.command == 'POST' and (path.startswith('/v1/audio/') or path == '/v1/voices'):
                CONTROLLER.begin_gpu_request()
                tracked = True
            body = self.request_body()
            connection_fields = {x.strip().lower() for x in self.headers.get('Connection', '').split(',')}
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in HOP_HEADERS | connection_fields | {'host', 'content-length'}}
            headers['Host'] = f'127.0.0.1:{BACKEND_PORT}'
            headers['Connection'] = 'close'
            if body is not None:
                headers['Content-Length'] = str(len(body))
            upstream.request(self.command, self.path, body=body, headers=headers)
            response = upstream.getresponse()
            self.send_response(response.status, response.reason)
            no_body = self.command == 'HEAD' or response.status in (204, 304)
            upstream_fields = {x.strip().lower() for x in response.getheader('Connection', '').split(',')}
            for key, value in response.getheaders():
                if key.lower() not in HOP_HEADERS | upstream_fields | {'server', 'date', 'content-length'}:
                    self.send_header(key, value)
            # Emit decoded upstream chunks immediately; never buffer the entire audio response.
            if not no_body:
                self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            started = True
            if not no_body:
                while block := response.read1(65536):
                    self.wfile.write(f'{len(block):X}\r\n'.encode('ascii'))
                    self.wfile.write(block)
                    self.wfile.write(b'\r\n')
                    self.wfile.flush()
                self.wfile.write(b'0\r\n\r\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except ControlError as error:
            self.close_connection = True
            if not started:
                self.send_json(error.status, {'error': str(error), 'code': error.code})
        except Exception as error:
            self.log_error('API relay failed: %s', type(error).__name__)
            if not started:
                payload = json.dumps({'error': '语音服务暂未就绪，请稍后重试或重新运行启动入口。'}, ensure_ascii=False).encode('utf-8')
                self.send_bytes(HTTPStatus.BAD_GATEWAY, payload, 'application/json; charset=utf-8')
            self.close_connection = True
        finally:
            upstream.close()
            if tracked:
                CONTROLLER.end_gpu_request()

    def dispatch(self):
        try:
            self.guard_local()
            self.route()
        except ControlError as error:
            self.close_connection = True
            self.send_json(error.status, {'error': str(error), 'code': error.code})

    def route(self):
        path = urlsplit(self.path).path
        if path.startswith('/local/'):
            self.local_control(path)
        elif self.command in ('GET', 'HEAD') and path == '/ui-health':
            self.send_bytes(200, b'{"status":"ok","locale":"zh-CN"}', 'application/json')
        elif self.command in ('GET', 'HEAD') and path in ASSETS:
            name, content_type = ASSETS[path]
            try:
                data = (ROOT / 'webui-zh' / name).read_bytes()
            except FileNotFoundError:
                self.send_error(503, 'Chinese UI assets are missing')
                return
            self.send_bytes(200, data, content_type)
        else:
            self.relay()

    do_GET = do_HEAD = do_POST = do_PATCH = do_PUT = do_DELETE = do_OPTIONS = dispatch


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', UI_PORT), Handler)
    server.daemon_threads = True
    print(f'Chinese Breeze UI listening on http://127.0.0.1:{UI_PORT}/', flush=True)
    server.serve_forever()
