interface Config {
  refreshInterval: number;
}

export function getConfig(): { getConfig(): Config } {
  return {
    getConfig: () => ({ refreshInterval: 0 }),
  };
}
