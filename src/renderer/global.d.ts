interface Window {
  // biome-ignore lint/suspicious/noExplicitAny: Preload contextBridge exposes dynamic IPC methods
  electronAPI: Record<string, any>;
}
