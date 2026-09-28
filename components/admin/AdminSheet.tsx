"use client";

import { XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * A Nightlight bottom sheet (all corners from `sm`) over the console. Without
 * `onClose` it cannot be dismissed by Escape, outside press or a close button.
 * Mount it to show it; Escape, outside press and the close button slide it out
 * before calling `onClose`.
 */
export function AdminSheet({
  title,
  description,
  children,
  footer,
  onClose,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
}) {
  // Base UI only animates an open *change*, so mount closed and open next frame.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);

  return (
    <Sheet
      open={open}
      disablePointerDismissal={!onClose}
      onOpenChange={(next) => {
        if (!next && onClose) setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose?.();
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="glass glass-thick inset-x-0 mx-auto max-h-[86dvh] w-full max-w-xl gap-0 rounded-t-[28px] border-0 p-0 pb-[var(--safe-bottom)] text-base outline-none duration-[380ms] ease-[cubic-bezier(0.32,0.72,0,1)] data-[side=bottom]:border-t-0 data-[side=bottom]:data-starting-style:translate-y-full data-[side=bottom]:data-ending-style:translate-y-full sm:data-[side=bottom]:bottom-3 sm:rounded-[28px] sm:pb-0 motion-reduce:data-[side=bottom]:data-starting-style:translate-y-0 motion-reduce:data-[side=bottom]:data-ending-style:translate-y-0"
      >
        <div className="shrink-0 px-5 pt-2">
          <div className="mx-auto h-[5px] w-9 rounded-full bg-white/25" aria-hidden="true" />
          <div className="flex min-h-12 items-center gap-3 pt-2">
            <SheetTitle className="type-headline min-w-0 flex-1 truncate text-glass-label">
              {title}
            </SheetTitle>
            {onClose ? (
              <SheetClose
                aria-label="Close"
                title="Close"
                className="pressable -mr-2 grid size-11 shrink-0 place-items-center rounded-full text-glass-label-2"
              >
                <span className="grid size-7 place-items-center rounded-full bg-white/10">
                  <XIcon size={16} strokeWidth={1.8} aria-hidden="true" />
                </span>
              </SheetClose>
            ) : null}
          </div>
        </div>
        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-1 pb-5">
          {description ? (
            <SheetDescription className="type-subhead mb-4 text-glass-label-2">
              {description}
            </SheetDescription>
          ) : null}
          {children}
        </div>
        {footer ? (
          <div className="flex shrink-0 gap-2 border-t border-white/10 px-5 pt-3 pb-4 *:flex-1">
            {footer}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
