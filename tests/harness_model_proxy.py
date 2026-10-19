"""Bounded host-only model access for isolated harness profiles; never copies keys."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pi-auth', type=Path, required=True)
    parser.add_argument('--upstream', default='https://api.z.ai/api/coding/paas/v4')
    parser.add_argument('--model', default='glm-5.3-flash')
    parser.add_argument('--ready', type=Path, required=True)
    parser.add_argument('--log', type=Path, required=True)
    parser.add_argument('--max-requests', type=int, default=32)
    args = parser.parse_args()
    # Read the user's existing credential in place. Only this host process owns
    # it; generated profiles and the offline desktop never receive the secret.
    credential = json.loads(args.pi_auth.read_text())['zai']['key']
    lock = threading.Lock()
    count = 0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.path.rstrip('/') != '/v1/models':
                self.send_error(404)
                return
            body = json.dumps({'object': 'list', 'data': [{'id': args.model, 'object': 'model'}]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            nonlocal count
            if self.path != '/v1/chat/completions':
                self.send_error(404)
                return
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            data = json.loads(body)
            if data.get('model') != args.model:
                self.send_error(400, 'Fixture model does not match the selected model')
                return
            with lock:
                count += 1
                sequence = count
            if sequence > args.max_requests:
                self.send_error(429, 'Fixture request budget exhausted')
                return
            summary = {'request': sequence, 'model': data['model'],
                       'messages': len(data.get('messages', [])),
                       'tools': [t.get('function', {}).get('name') for t in data.get('tools', [])]}
            request = urllib.request.Request(args.upstream + '/chat/completions', data=body,
                headers={'Authorization': 'Bearer ' + credential, 'Content-Type': 'application/json'})
            try:
                response = urllib.request.urlopen(request, timeout=180)
            except urllib.error.HTTPError as exc:
                summary['status'] = exc.code
                with lock, args.log.open('a') as stream:
                    stream.write(json.dumps(summary) + '\n')
                self.send_response(exc.code)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(exc.read())
                return
            summary['status'] = response.status
            with lock, args.log.open('a') as stream:
                stream.write(json.dumps(summary) + '\n')
            self.send_response(response.status)
            self.send_header('Content-Type', response.headers.get('Content-Type', 'application/json'))
            self.end_headers()
            try:
                with response:
                    while chunk := response.read1(8192):
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    args.ready.write_text(json.dumps({'base_url': f'http://127.0.0.1:{server.server_port}/v1',
                                      'model': args.model}))
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
