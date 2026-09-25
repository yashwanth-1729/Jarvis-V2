"use client";

import * as React from "react";
import { Drawer } from "vaul";
import { X } from "@phosphor-icons/react";

import { useBackLayer } from "../lib/backStack";
import { usePhoneRoot } from "../PhoneContext";
import { Tap } from "./Tap";

/**
 * A bottom sheet: drag it down to dismiss, and Android's back button closes
 * it.
 *
 * vaul does the physics (velocity-aware release, scroll-vs-drag arbitration
 * inside long forms, keyboard repositioning); this wrapper adds the phone's
 * look, the history entry and a real close button. The app behind is not
 * scaled back: that re-rasterised the whole screen at the phone's pixel
 * density on every open, which is where sheets used to stutter.
 */
export function Sheet({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  tone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  tone?: string;
}) {
  const root = usePhoneRoot();
  useBackLayer(open, onClose);
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      container={root}
      shouldScaleBackground={false}
      noBodyStyles
      repositionInputs
    >
      <Drawer.Portal container={root}>
        <Drawer.Overlay className="ph-sheet-overlay" />
        <Drawer.Content className="ph-sheet" data-tone={tone} aria-describedby={undefined}>
          <div className="ph-sheet-grip" aria-hidden="true" />
          <header className="ph-sheet-head">
            <div>
              {eyebrow && <span className="ph-eyebrow">{eyebrow}</span>}
              <Drawer.Title className="ph-sheet-title">{title}</Drawer.Title>
            </div>
            <Tap className="ph-icon-btn" aria-label="Close" onClick={onClose} feel="select">
              <X size={20} weight="bold" />
            </Tap>
          </header>
          <div className="ph-sheet-body">{children}</div>
          {footer && <footer className="ph-sheet-foot">{footer}</footer>}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
