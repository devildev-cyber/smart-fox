"use client";

import * as React from "react";
import { Minus, Pin, PinOff, X } from "lucide-react";
import { getElectronAPI } from "@/lib/electron";

// Custom window chrome for the frameless Electron overlay. Renders nothing in a
// normal browser. The bar itself is the OS drag region; buttons opt out.
const dragStyle = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragStyle = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export function ElectronTitlebar() {
  const [mounted, setMounted] = React.useState(false);
  const [pinned, setPinned] = React.useState(true);

  React.useEffect(() => setMounted(true), []);

  const api = mounted ? getElectronAPI() : null;
  if (!api) return null;

  return (
    <div
      style={dragStyle}
      className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-card/80 px-3 backdrop-blur"
    >
      <span className="text-xs font-medium text-muted-foreground">
        Interview Coach — ⌘/Ctrl+Shift+Enter to answer
      </span>
      <div style={noDragStyle} className="flex items-center gap-1">
        <button
          type="button"
          aria-label={pinned ? "Unpin window" : "Pin window on top"}
          title={pinned ? "Always on top: on" : "Always on top: off"}
          onClick={async () => setPinned(await api.togglePin())}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {pinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => api.minimize()}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={() => api.close()}
          className="rounded p-1 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
