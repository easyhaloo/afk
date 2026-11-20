import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import tomllib


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('release', type=Path)
    parser.add_argument('receipt', type=Path)
    parser.add_argument('case', choices=['exec', 'app-server', 'qa', 'failure', 'cancel', 'resume', 'workflow-handoff'])
    args = parser.parse_args()
    release = args.release.resolve(strict=True)
    receipt = args.receipt.resolve()
    if receipt.exists():
        raise SystemExit('Choose a fresh receipt filename')
    binary = shutil.which('codex')
    node = shutil.which('node')
    if not binary or not node:
        raise SystemExit('Both codex and node must be on PATH')
    version = subprocess.check_output([binary, '--version'], text=True).strip()
    config_file = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'config.toml'
    config = tomllib.loads(config_file.read_text())
    provider = config['model_providers'][config['model_provider']]
    token = provider.get('experimental_bearer_token') or os.environ.get(provider.get('env_key', ''))
    if not token:
        raise SystemExit('This fixture requires a configured API provider with environment or bearer authentication')
    driver = Path(__file__).with_suffix('.mjs').resolve()
    with tempfile.TemporaryDirectory(prefix='w10-codex-') as temporary:
        root = Path(temporary).resolve()
        for directory in ['home', 'home/.codex', 'tmp', 'work']:
            (root / directory).mkdir(mode=0o700)
        endpoint = provider['base_url']
        settings = dict(model=config['model'], model_provider='qual', model_reasoning_effort='low', check_for_update_on_startup=False)
        lines = [f'{key} = {json.dumps(value)}' for key, value in settings.items()]
        lines += ['[model_providers.qual]', 'name = "Qualification"', f'base_url = {json.dumps(endpoint)}',
                  'env_key = "QUAL_MODEL_AUTH"', 'wire_api = "responses"', 'requires_openai_auth = false',
                  '[shell_environment_policy]', 'inherit = "core"', 'exclude = ["QUAL_MODEL_AUTH"]']
        (root / 'home/.codex/config.toml').write_text('\n'.join(lines) + '\n')
        env = dict(PATH=os.pathsep.join([str(Path(binary).parent), str(Path(node).parent), '/usr/bin', '/bin']),
                   HOME=str(root / 'home'), CODEX_HOME=str(root / 'home/.codex'), TMPDIR=str(root / 'tmp'),
                   AFK_EVENT_STORE_DIR=str(root / 'home/events'), QUAL_MODEL_AUTH=token, LANG='en_US.UTF-8', SHELL='/bin/sh')
        with subprocess.Popen([node, driver, release, root, receipt, args.case, version], env=env,
                              cwd=root / 'work', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              start_new_session=True) as child:
            try:
                status = child.wait(timeout=240)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                if not receipt.exists():
                    with open(receipt, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
                        json.dump({'scenario': args.case, 'phase': 'launcher-interrupted', 'passed': False}, output)
                status = 1
    if receipt.exists():
        print(receipt.read_text())
    raise SystemExit(status)


if __name__ == '__main__':
    main()
