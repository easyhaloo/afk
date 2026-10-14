export function installLoopSignalHandlers(
  stop: () => Promise<void>,
  notify: (signal: 'SIGINT' | 'SIGTERM') => void,
  onError: (error: unknown) => void,
  signals: NodeJS.EventEmitter = process,
): () => void {
  let shutdown: Promise<void> | undefined;
  const handle = (signal: 'SIGINT' | 'SIGTERM') => {
    if (shutdown) return;
    notify(signal);
    shutdown = stop().catch(onError);
  };
  const interrupt = () => handle('SIGINT');
  const terminate = () => handle('SIGTERM');
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', terminate);
  return () => {
    signals.removeListener('SIGINT', interrupt);
    signals.removeListener('SIGTERM', terminate);
  };
}
