"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AdminSheet } from "./AdminSheet";
import { PRIORITY_LABEL, explainPriority, usesCloud } from "./explain";
import { fromDateTimeLocal, toDateTimeLocal } from "./format";
import { POLICY_PRESETS } from "./presets";
import { validateDraft } from "./policy";
import type { KeyDraft, KeyPolicy, PolicyPresetId, Priority } from "./types";

const PRIORITIES: readonly Priority[] = ["high", "medium", "low"];
const labelClass = "type-footnote font-semibold text-glass-label-2";
const hintClass = "type-footnote mt-2 text-glass-label-2";
const fieldClass =
  "mt-2 h-11 rounded-xl border-0 bg-white/8 px-3 text-[1rem] text-glass-label placeholder:text-glass-label-3 focus-visible:bg-white/12 focus-visible:ring-0 focus-visible:inset-ring-[1.5px] focus-visible:inset-ring-white/40 disabled:bg-white/5 md:text-[1rem]";
const chipClass =
  "h-11 rounded-full px-4 type-subhead font-semibold text-glass-label hover:bg-white/14 hover:text-glass-label";

export function KeyEditor({
  mode,
  draft,
  busy,
  error,
  conflict,
  onChange,
  onClose,
  onSubmit,
  onRotate,
  onRevoke,
}: {
  mode: "create" | "edit";
  draft: KeyDraft;
  busy: boolean;
  error: string | null;
  conflict: boolean;
  onChange: (draft: KeyDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
  onRotate?: () => void;
  onRevoke?: () => void;
}) {
  const [preset, setPreset] = useState<PolicyPresetId | null>(
    mode === "create" ? "standard" : null,
  );
  const validation = useMemo(() => validateDraft(draft), [draft]);
  const ids = {
    name: useId(),
    suggestion: useId(),
    priority: useId(),
    priorityHint: useId(),
    cloud: useId(),
    cloudHint: useId(),
    rpm: useId(),
    concurrent: useId(),
    expires: useId(),
  };
  const low = draft.policy.priority === "low";
  // An empty name only disables Save; don't greet a new key with an error.
  const shownValidation = draft.name.trim().length === 0 ? null : validation;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (validation || busy) {
      return;
    }
    onSubmit();
  };

  const editPolicy = (patch: Partial<KeyPolicy>) => {
    setPreset(null);
    onChange({ ...draft, policy: { ...draft.policy, ...patch } });
  };

  return (
    <AdminSheet
      title={mode === "create" ? "Create Key" : "Edit Key"}
      description={
        mode === "create"
          ? "Pick a suggestion, then adjust. The secret is shown once, after you create the key."
          : "Saving replaces this key’s policy. The secret stays the same."
      }
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="key-editor-form" disabled={busy || validation !== null}>
            {busy ? "Saving…" : mode === "create" ? "Create Key" : "Save Key"}
          </Button>
        </>
      }
    >
      <form id="key-editor-form" className="space-y-6" onSubmit={submit}>
        {conflict ? (
          <div role="status" className="rounded-2xl bg-white/7 p-4">
            <p className="type-headline">This key was changed elsewhere</p>
            <p className="type-footnote mt-1 text-glass-label-2">
              Your draft is still here. Save again to apply it.
            </p>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="type-footnote text-[#ff8a82]">
            {error}
          </p>
        ) : null}

        <div>
          <Label htmlFor={ids.name} className={labelClass}>
            Name
          </Label>
          <Input
            id={ids.name}
            className={fieldClass}
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder="e.g. Open WebUI"
            maxLength={80}
            required
            autoComplete="off"
            disabled={busy}
          />
        </div>

        <div>
          <p id={ids.suggestion} className={labelClass}>
            Suggestion
          </p>
          <ToggleGroup
            aria-labelledby={ids.suggestion}
            className="mt-2 flex-wrap gap-2"
            value={preset ? [preset] : []}
            onValueChange={(value: string[]) => {
              const item = POLICY_PRESETS.find((candidate) => candidate.id === value[0]);
              if (!item) return; // Pressing the chosen suggestion again keeps it.
              setPreset(item.id);
              onChange({ ...draft, policy: { ...item.policy } });
            }}
          >
            {POLICY_PRESETS.map((item) => (
              <ToggleGroupItem
                key={item.id}
                value={item.id}
                title={item.summary}
                disabled={busy}
                className={`${chipClass} bg-white/10 aria-pressed:bg-white/22 aria-pressed:inset-ring-[1.5px] aria-pressed:inset-ring-white/50`}
              >
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div>
          <p id={ids.priority} className={labelClass}>
            Priority
          </p>
          <ToggleGroup
            role="radiogroup"
            aria-labelledby={ids.priority}
            aria-describedby={ids.priorityHint}
            className="mt-2 grid w-full grid-cols-3 gap-1 rounded-full bg-white/8 p-1"
            value={[draft.policy.priority]}
            onValueChange={(value: string[]) => {
              const next = PRIORITIES.find((priority) => priority === value[0]);
              if (next) editPolicy({ priority: next });
            }}
          >
            {PRIORITIES.map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                role="radio"
                aria-checked={draft.policy.priority === value}
                aria-pressed={undefined}
                disabled={busy}
                className={`${chipClass} text-glass-label-2 hover:bg-transparent aria-checked:bg-white/16 aria-checked:text-glass-label aria-checked:shadow-sm`}
              >
                {PRIORITY_LABEL[value]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p id={ids.priorityHint} className={hintClass} aria-live="polite">
            {explainPriority(draft.policy.priority)}
          </p>
        </div>

        <label className="flex min-h-11 items-center gap-4 rounded-2xl bg-white/7 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span id={ids.cloud} className="type-headline block">
              Cloud
            </span>
            <span id={ids.cloudHint} className="type-footnote block text-glass-label-2">
              {low
                ? "Low priority never uses cloud."
                : "May use OpenRouter (paid) when the GPU can’t take the request."}
            </span>
          </span>
          <Switch
            aria-labelledby={ids.cloud}
            aria-describedby={ids.cloudHint}
            checked={usesCloud(draft.policy)}
            disabled={busy || low}
            onCheckedChange={(cloud) => editPolicy({ cloud })}
          />
        </label>

        <div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              id={ids.rpm}
              label="Requests / minute"
              value={draft.policy.requestsPerMinute}
              disabled={busy}
              onChange={(requestsPerMinute) => editPolicy({ requestsPerMinute })}
            />
            <NumberField
              id={ids.concurrent}
              label="Max concurrent"
              value={draft.policy.maxConcurrent}
              disabled={busy}
              onChange={(maxConcurrent) => editPolicy({ maxConcurrent })}
            />
          </div>
          <p className={hintClass}>Abuse limits. 0 means unlimited.</p>
        </div>

        <div>
          <Label htmlFor={ids.expires} className={labelClass}>
            Expires
          </Label>
          <Input
            id={ids.expires}
            type="datetime-local"
            className={fieldClass}
            value={toDateTimeLocal(draft.expiresAt)}
            onChange={(event) =>
              onChange({ ...draft, expiresAt: fromDateTimeLocal(event.target.value) })
            }
            disabled={busy}
          />
          <p className={hintClass}>Leave empty and the key never expires.</p>
        </div>

        {shownValidation ? (
          <p role="alert" className="type-footnote text-[#ff8a82]">
            {shownValidation}
          </p>
        ) : null}

        {onRotate && onRevoke ? (
          <div className="border-t border-white/10 pt-5">
            <p className={labelClass}>Secret and access</p>
            <div className="mt-2 flex gap-2 *:flex-1">
              <Button variant="secondary" type="button" onClick={onRotate} disabled={busy}>
                Rotate Secret
              </Button>
              <Button variant="destructive" type="button" onClick={onRevoke} disabled={busy}>
                Revoke Key
              </Button>
            </div>
          </div>
        ) : null}
      </form>
    </AdminSheet>
  );
}

function NumberField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <Label htmlFor={id} className={labelClass}>
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        className={`${fieldClass} tabular-nums`}
        value={Number.isFinite(value) ? value : ""}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
