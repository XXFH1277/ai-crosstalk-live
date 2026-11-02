"""Serve the local Chinese UI and relay HTTP APIs to the Breeze runtime."""
from http import HTTPStatus
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
ASSETS = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
    '/style.css': ('style.css', 'text/css; charset=utf-8'),
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
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

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
        upstream = HTTPConnection('127.0.0.1', 8082, timeout=180)
        started = False
        try:
            body = self.request_body()
            connection_fields = {x.strip().lower() for x in self.headers.get('Connection', '').split(',')}
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in HOP_HEADERS | connection_fields | {'host', 'content-length'}}
            headers['Host'] = '127.0.0.1:8082'
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
        except Exception as error:
            self.log_error('API relay failed: %s', type(error).__name__)
            if not started:
                payload = json.dumps({'error': '语音服务暂未就绪，请稍后重试或重新运行启动入口。'}, ensure_ascii=False).encode('utf-8')
                self.send_bytes(HTTPStatus.BAD_GATEWAY, payload, 'application/json; charset=utf-8')
            self.close_connection = True
        finally:
            upstream.close()

    def dispatch(self):
        path = urlsplit(self.path).path
        if self.command in ('GET', 'HEAD') and path == '/ui-health':
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
    server = ThreadingHTTPServer(('127.0.0.1', 8080), Handler)
    server.daemon_threads = True
    print('Chinese Breeze UI listening on http://127.0.0.1:8080/', flush=True)
    server.serve_forever()
