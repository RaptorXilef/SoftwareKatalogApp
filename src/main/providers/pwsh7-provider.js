import path from 'node:path';
import { createPowerShellGalleryProvider } from './ps-gallery-common.js';

function getPwsh7ExtraPaths() {
  const candidates = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  }
  return candidates;
}

export const pwsh7Provider = createPowerShellGalleryProvider({
  id: 'pwsh7',
  name: 'PowerShell 7',
  description: 'PowerShell 7.x Module (PSResourceGet / PowerShellGet via pwsh.exe)',
  binary: 'pwsh.exe',
  extraPaths: getPwsh7ExtraPaths,
  preferPsResourceGet: true,
  isSystemComponent: false,
  canInstallManager: true,
  canUninstallManager: true,
  requiresAdminForBootstrap: true,
  uninstallWarning: 'Achtung: PowerShell 7 wird ueber Winget vom System entfernt.',
  wingetId: 'Microsoft.PowerShell',
});
