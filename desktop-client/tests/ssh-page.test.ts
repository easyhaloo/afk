import { describe, expect, it } from "vitest";
import { filterSshHosts } from "../src/features/ssh/SshHostsPage";
import type { SshHost } from "../shared/ssh-contract";

const hosts: SshHost[] = [
  { id: "system:prod", alias: "prod", hostname: "10.0.0.1", port: 22, source: "system", configPath: "~/.ssh/config", status: "ready" },
  { id: "managed:stage", alias: "stage", hostname: "staging.example.test", port: 2200, source: "managed", configPath: "~/.ssh/afk_hosts", status: "untrusted" },
];

describe("SSH host filtering", () => {
  it("combines query, source, and status without mutating the list", () => {
    expect(filterSshHosts(hosts, "staging", "managed", "untrusted")).toEqual([hosts[1]]);
    expect(hosts).toHaveLength(2);
  });
});
