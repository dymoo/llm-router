"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { AdminSheet } from "./AdminSheet";
import type { RevealedSecret } from "./types";

export function SecretReveal({
  revealed,
  onDismiss,
}: {
  revealed: RevealedSecret;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const rotated = revealed.reason === "rotated";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <AdminSheet
      title={rotated ? "New Secret" : "Key Secret"}
      description={
        rotated
          ? `The old secret for ${revealed.key.name} no longer works. Copy the new one now: it’s shown once and isn’t stored in this browser.`
          : `${revealed.key.name} is ready. Copy its secret now: it’s shown once and isn’t stored in this browser.`
      }
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onDismiss}>
            Done
          </Button>
          <Button type="button" onClick={() => void copy()}>
            {copied ? (
              <CheckIcon size={18} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <CopyIcon size={18} strokeWidth={1.8} aria-hidden="true" />
            )}
            {copied ? "Copied" : "Copy Secret"}
          </Button>
        </>
      }
    >
      <p
        tabIndex={0}
        className="rounded-xl bg-black/30 p-3 font-mono text-[0.875rem] leading-relaxed break-all select-all"
      >
        {revealed.secret}
      </p>
      <p className="type-footnote mt-2 text-glass-label-2">
        Prefix <span className="font-mono">{revealed.key.prefix}</span>
      </p>
    </AdminSheet>
  );
}
