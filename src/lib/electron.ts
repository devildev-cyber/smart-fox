// Typed accessor for the preload bridge exposed by the Electron shell.
// Returns null in a normal browser so the same UI works everywhere.
export interface ElectronAPI {
  isElectron: true;
  platform: NodeJS.Platform;
  minimize: () => void;
  close: () => void;
  togglePin: () => Promise<boolean>;
  onGenerate: (callback: () => void) => () => void;
  liveCaptions: {
    start: () => void;
    stop: () => void;
    onText: (callback: (text: string) => void) => () => void;
    onError: (callback: (message: string) => void) => () => void;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export function getElectronAPI(): ElectronAPI | null {
  if (typeof window === "undefined") return null;
  return window.electronAPI ?? null;
}

export function isElectron(): boolean {
  return getElectronAPI() !== null;
}
