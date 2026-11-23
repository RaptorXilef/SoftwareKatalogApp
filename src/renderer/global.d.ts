interface Window {
  // biome-ignore lint/suspicious/noExplicitAny: Electron Preload API bridge
  electronAPI: Record<string, any>;
}
