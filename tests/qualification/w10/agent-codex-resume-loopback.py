import argparse
import json
import os
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Responses(BaseHTTPRequestHandler):
    calls = 0

    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != '/v1/responses':
            self.send_error(404)
            return
        self.rfile.read(int(self.headers['Content-Length']))
        Responses.calls += 1
        first = Responses.calls == 2
        text = 'Synthetic handoff' if first else '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>'
        usage = dict(input_tokens=10 if first else 15, output_tokens=2, total_tokens=12 if first else 17)
        response = dict(id=f'resp_{Responses.calls}')
        events = [dict(type='response.created', response=response),
                  dict(type='response.output_item.done', item=dict(type='message', id='fixture', role='assistant',
                       content=[dict(type='output_text', text=text)])),
                  dict(type='response.completed', response={**response, 'usage': usage})]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for event in events:
            self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('receipt', type=Path)
    receipt = parser.parse_args().receipt.resolve()
    if receipt.exists():
        raise SystemExit('Choose a fresh receipt filename')
    driver = Path(__file__).with_name('agent-codex.mjs').resolve()
    with tempfile.TemporaryDirectory() as temporary, ThreadingHTTPServer(('127.0.0.1', 0), Responses) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        root = Path(temporary).resolve()
        workspace, codex_home = root / 'work', root / '.codex'
        workspace.mkdir()
        codex_home.mkdir()
        (codex_home / 'config.toml').write_text(f'model="gpt-5.1"\nmodel_provider="fixture"\n'
            f'[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:{server.server_port}/v1"\nwire_api="responses"\n')
        env = dict(PATH=os.environ['PATH'], HOME=str(root), CODEX_HOME=str(codex_home), AFK_EVENT_STORE_DIR=str(root / 'events'), SHELL='/bin/sh')
        version = subprocess.check_output(['codex', '--version'], env=env, text=True).strip()
        result = subprocess.run([shutil.which('node'), str(driver), str(driver.parents[3]), str(root), str(receipt),
                                 'resume-loopback', version], cwd=workspace, env=env, timeout=120)
        if not result.returncode and Responses.calls != 3:
            raise SystemExit('Expected a readiness probe and two work turns')
        raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
