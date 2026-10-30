import { describe, expect, it } from 'vitest';
import { probeForTool, requiredToolsForCommand, toolRequirements } from './ac-tools.js';

describe('acceptance criterion tool requirements', () => {
  it('reads the binary a check command runs', () => {
    expect(requiredToolsForCommand('mvn -q -pl aiapi-service -am test -Dtest=WikiRouteRegistryStartUpTest')).toEqual(['mvn']);
    expect(requiredToolsForCommand('pytest knowledge/tests/test_recall_headers.py')).toEqual(['pytest']);
    expect(requiredToolsForCommand("! grep -rn 'addListener' src/")).toEqual(['grep']);
  });

  it('reads every binary a pipeline runs', () => {
    expect(requiredToolsForCommand("curl -fsS http://localhost:8080/health/ready | jq -e '.llm == true'")).toEqual(['curl', 'jq']);
  });

  it('does not mistake a shell builtin or an assignment for a tool', () => {
    expect(requiredToolsForCommand("echo 'manual review needed'")).toEqual([]);
    expect(requiredToolsForCommand('export FOO=1 && mvn test')).toEqual(['mvn']);
    expect(requiredToolsForCommand('cd /tmp/qa && python3 -m pytest t.py')).toEqual(['python3']);
  });

  it('carries the criterion and command with the requirement', () => {
    expect(toolRequirements('Nacos 不可达时进程启动失败', 'mvn test')).toEqual([
      { tool: 'mvn', criterion: 'Nacos 不可达时进程启动失败', checkCommand: 'mvn test' },
    ]);
  });

  describe('probes', () => {
    it('collects a pytest suite instead of asking for its version', () => {
      const probe = probeForTool('pytest', 'pytest knowledge/tests/test_recall_headers.py');
      expect(probe.command).toBe('python3');
      expect(probe.args).toContain('--collect-only');
      expect(probe.args).toContain('knowledge/tests/test_recall_headers.py');
    });

    it('asks a build tool for its version', () => {
      expect(probeForTool('mvn', 'mvn test')).toEqual({ command: 'mvn', args: ['-v'] });
      expect(probeForTool('gradle', 'gradle test')).toEqual({ command: 'gradle', args: ['-v'] });
      expect(probeForTool('go', 'go test ./...')).toEqual({ command: 'go', args: ['version'] });
    });

    it('does not collect a suite that names no test file', () => {
      const probe = probeForTool('pytest', 'pytest --maxfail=1');
      expect(probe.args).not.toContain('knowledge/tests/test_recall_headers.py');
    });
  });
});
