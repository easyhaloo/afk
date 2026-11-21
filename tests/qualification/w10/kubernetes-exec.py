#!/usr/bin/env python3
"""Run with Python 3, kind, kubectl, Docker, and node on PATH.

python3 tests/qualification/w10/kubernetes-exec.py /path/to/installed/afk /path/to/local/docker.sock
Preload NODE_IMAGE and alpine:3.20 in that Docker engine. JSON on stdout is the receipt.
"""
import argparse
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit


NODE_IMAGE = 'kindest/node:v1.32.2@sha256:f226345927d7e348497136874b6d207e0b32cc52154ad8323129352923a3142f'
POD_IMAGE = 'alpine:3.20'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def qualify(root, afk, socket):
    name = 'afk-w10-' + uuid.uuid4().hex[:12]
    context = 'kind-' + name
    namespace = 'qualification'
    pod = 'identity'
    config = root / 'kubeconfig'
    env = dict(PATH=os.environ['PATH'], HOME=str(root), DOCKER_HOST='unix://' + str(socket),
               DOCKER_CONFIG=str(root / 'docker'), KUBECONFIG=str(config), KIND_EXPERIMENTAL_PROVIDER='docker',
               KIND_EXPERIMENTAL_DOCKER_NETWORK=name)

    def run(*args, input_text=None, expected=0, timeout=90):
        result = subprocess.run(args, cwd=root, env=env, input=input_text, text=True,
                                capture_output=True, timeout=timeout)
        if result.returncode != expected:
            raise RuntimeError(f'{args[0]} {args[1]} returned {result.returncode}: {result.stderr.strip()}')
        return result.stdout.strip()

    def kube(*args, **options):
        return run('kubectl', '--kubeconfig', config, '--context', context, *args, **options)

    require(socket.is_socket(), 'A local Docker engine Unix socket is required')
    release = json.loads((afk.parent.parent / 'release.json').read_text())
    version = run(afk, '--version')
    require(version == release['version'] and afk.name == 'index.js', 'Expected installed AFK release')
    tools = dict(kind=run('kind', 'version'), kubectl=json.loads(run('kubectl', 'version', '--client', '-o', 'json'))['clientVersion']['gitVersion'],
                 docker=run('docker', 'version', '--format', '{{.Server.Version}}'))
    for image in (NODE_IMAGE, POD_IMAGE):
        run('docker', 'image', 'inspect', '--format', '{{.Id}}', image)
    label = 'label=io.x-k8s.kind.cluster=' + name
    require(not run('docker', 'ps', '-aq', '--filter', label), 'Node name already in use')
    network = run('docker', 'network', 'create', name)
    present = False
    try:
        run('kind', 'create', 'cluster', '--name', name, '--image', NODE_IMAGE, '--kubeconfig', config, '--wait', '120s', timeout=240)
        endpoint = urlsplit(kube('config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}'))
        require(endpoint.scheme == 'https' and endpoint.hostname == '127.0.0.1', 'Expected loopback API')
        server = json.loads(kube('version', '-o', 'json'))['serverVersion']['gitVersion']
        platform = run('docker', 'image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', POD_IMAGE)
        archive = root / 'pod-image.tar'
        run('docker', 'image', 'save', '--platform', platform, '-o', archive, POD_IMAGE)
        run('kind', 'load', 'image-archive', archive, '--name', name)
        kube('create', 'namespace', namespace)
        present = True
        spec = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': pod, 'namespace': namespace},
                'spec': {'automountServiceAccountToken': False, 'terminationGracePeriodSeconds': 1,
                         'containers': [{'name': 'probe', 'image': POD_IMAGE, 'imagePullPolicy': 'Never',
                                         'securityContext': {'runAsUser': 12345}, 'command': ['sleep', '300'],
                                         'env': [{'name': 'POD_UID', 'valueFrom': {'fieldRef': {'fieldPath': 'metadata.uid'}}}]}]}}
        kube('create', '-f', '-', input_text=json.dumps(spec))
        kube('wait', '-n', namespace, '--for=condition=Ready', 'pod/' + pod, '--timeout=60s')
        actual = json.loads(kube('get', 'pod', pod, '-n', namespace, '-o', 'json'))
        uid = actual['metadata']['uid']
        settings = root / 'host.json'
        settings.write_text(json.dumps(dict(kubeconfig=str(config), context=context, namespace=namespace,
                                            hosts=[dict(alias='target', pod=pod, container='probe')])))
        run(afk, 'plugin', 'configure', 'host.kubernetes-exec', '--builtin', '--file', settings)
        host = [afk, 'host', 'exec', '--provider', 'kubernetes-exec', '--json', 'target', '--']
        identity = json.loads(run(*host, 'sh', '-c', 'hostname && id -u && printenv POD_UID'))
        require(identity['ok'] and identity['result']['code'] == 0 and
                identity['result']['stdout'].splitlines() == [pod, '12345', uid], 'Pod identity mismatch')
        failure = json.loads(run(*host, 'sh', '-c', 'echo qualification >&2; exit 23', expected=23))
        require(failure['ok'] is False and failure['result']['code'] == 23 and
                'qualification' in failure['result']['stderr'].splitlines(), 'Lost container exit or stderr')
    finally:
        try:
            if present:
                kube('delete', 'pod', pod, '-n', namespace, '--ignore-not-found', '--timeout=45s')
                require(not kube('get', 'pod', pod, '-n', namespace, '--ignore-not-found', '-o', 'name'), 'Pod remains')
                kube('delete', 'namespace', namespace, '--timeout=45s')
                require(not kube('get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'), 'Namespace remains')
        finally:
            run('kind', 'delete', 'cluster', '--name', name, '--kubeconfig', config)
            require(not run('docker', 'ps', '-aq', '--filter', label), 'Kind node remains')
            if run('docker', 'network', 'ls', '--filter', 'id=' + network, '-q'):
                run('docker', 'network', 'rm', network)
            require(not run('docker', 'network', 'ls', '--filter', 'id=' + network, '-q'), 'Kind network remains')
    return dict(version=version, tools=tools, server=server, nodeImage=NODE_IMAGE, cluster=name, loopback=endpoint.hostname,
                namespace=namespace, pod=pod, container='probe', podImage=actual['status']['containerStatuses'][0]['imageID'],
                apiPodUid=uid, hostStdout=identity['result']['stdout'].splitlines(), remoteExit=failure['result']['code'],
                cliExit=23, stderr=failure['result']['stderr'].splitlines(), removed=['pod', 'namespace', 'kind node', 'docker network'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('afk', type=Path)
    parser.add_argument('socket', type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='afk-kind-') as directory:
        print(json.dumps(qualify(Path(directory).resolve(), args.afk.resolve(), args.socket.resolve()), indent=2))
