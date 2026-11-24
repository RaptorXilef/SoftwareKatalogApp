import path from 'node:path';
import { createPowerShellGalleryProvider } from './ps-gallery-common.js';

function getPwsh5ExtraPaths() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return [path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
}

export const pwsh5Provider = createPowerShellGalleryProvider({
  id: 'pwsh5',
  name: 'PowerShell 5.1',
  description: 'Windows PowerShell 5.1 Module (PowerShellGet via powershell.exe)',
  binary: 'powershell.exe',
  extraPaths: getPwsh5ExtraPaths,
  preferPsResourceGet: false,
  isSystemComponent: true,
  canInstallManager: false,
  canUninstallManager: false,
  requiresAdminForBootstrap: false,
});
