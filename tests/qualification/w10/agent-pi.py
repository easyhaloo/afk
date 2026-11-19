"""Run the installed driver in a fresh home with one explicitly selected Pi model."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
from urllib.parse import urlparse


def configure_model(model_dir, agent):
    settings = json.loads((model_dir / 'settings.json').read_text())
    provider_id, model_id = settings['defaultProvider'], settings['defaultModel']
    provider = json.loads((model_dir / 'models.json').read_text())['providers'][provider_id]
    model = next(model for model in provider['models'] if model['id'] == model_id)
    endpoint = urlparse(provider['baseUrl'])
    if endpoint.scheme != 'https' and not (endpoint.scheme == 'http' and endpoint.hostname in ('localhost', '127.0.0.1', '::1')):
        raise SystemExit('Expected HTTPS or an HTTP loopback model')
    key = provider.get('apiKey', '')
    if key.startswith('!') or provider.get('headers') or model.get('headers'):
        raise SystemExit('Use a dedicated configuration with simple API-key authentication')
    selected = {name: provider[name] for name in ('baseUrl', 'api', 'compat', 'authHeader') if name in provider}
    selected.update(models=[model], apiKey='$QUAL_PI_AUTH')
    (agent / 'models.json').write_text(json.dumps({'providers': {provider_id: selected}}))
    (agent / 'settings.json').write_text(json.dumps(dict(defaultModel=model_id, defaultProvider=provider_id,
                                                       retry={'enabled': False})))
    return os.environ[key[1:]] if key.startswith('$') else key


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('afk', type=Path, help='executable created by install.sh')
    parser.add_argument('scenario', choices=['success', 'cancel'])
    parser.add_argument('receipt', type=Path)
    parser.add_argument('--expected-version', default='0.2.150', help='required installed AFK CLI version')
    parser.add_argument('--model-dir', type=Path, help='opt into approved Pi default model instead of the loopback fixture')
    args = parser.parse_args()
    os.umask(0o077)
    receipt = args.receipt.resolve()
    driver = Path(__file__).resolve().with_suffix('.mjs')
    afk = args.afk.resolve(strict=True)
    release = afk.parents[1]
    pi, node = (shutil.which(name) for name in ('pi', 'node'))
    if not pi or not node:
        raise SystemExit('pi and node must be on PATH')
    with receipt.open('x') as output, tempfile.TemporaryDirectory(prefix='w10-pi-') as temporary:
        root = Path(temporary).resolve()
        agent = root / 'home/.pi/agent'
        agent.mkdir(parents=True)
        work = root / 'work'
        work.mkdir()
        (root / 'tmp').mkdir()
        mode = 'configured-default' if args.model_dir else 'isolated-loopback-fixture'
        env = dict(PATH=os.pathsep.join([str(Path(pi).parent), str(Path(node).parent), '/usr/bin', '/bin']),
                   HOME=str(root / 'home'), PI_CODING_AGENT_DIR=str(agent), TMPDIR=str(root / 'tmp'),
                   PI_OFFLINE='1', AFK_EVENT_STORE_DIR=str(root / 'events'),
                   SHELL='/bin/sh', LANG='en_US.UTF-8')
        if args.model_dir:
            env['QUAL_PI_AUTH'] = configure_model(args.model_dir, agent)
        def version(binary):
            return subprocess.check_output([binary, '--version'], env=env, cwd=work, stderr=subprocess.DEVNULL,
                                           timeout=15, text=True).strip()
        manifest = json.loads((release / 'release.json').read_text())
        report = dict(scenario=args.scenario, passed=False, phase='installation', evidenceLevel='native',
                      modelSource=mode, platform=manifest['platform'])
        try:
            report['afk'], report['pi'] = version(afk), version(pi)
            match = re.fullmatch(re.escape(args.expected_version) + r'-(darwin|linux)-(arm64|x64)-([a-f0-9]{64})', release.name)
            if (not match or not (report['afk'] == args.expected_version == manifest['version'])
                    or (match[1], match[2]) != (manifest['platform'], manifest['arch'])
                    or not re.fullmatch(r'\d+\.\d+\.\d+', report['pi'])):
                raise ValueError('unexpected installation')
            report.update(archiveSha256=match[3], arch=match[2], phase='driver')
            with subprocess.Popen([node, driver, release, args.scenario, mode], cwd=work, env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True) as child:
                try:
                    status = child.wait(timeout=150)
                except (KeyboardInterrupt, subprocess.TimeoutExpired):
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    raise
            report.update(json.loads((root / 'result.json').read_text()))
            report['passed'] = status == 0 and report['passed']
        finally:
            json.dump(report, output, indent=2)
            output.write('\n')
        return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
