"use client";

import { Check, Plus, Save, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";

import type { BrandVault } from "@seo/db";

import { saveBrandVault, type BrandVaultInput } from "@/app/actions/brand-vault";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Label, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/misc";

/**
 * The Brand Vault form.
 *
 * Everything here is injected into every generation prompt, so the field hints
 * are written to explain what each one changes about the output — a vague
 * "tone of voice" produces generic articles, and the form should say so.
 */
export function BrandVaultForm({
  clientId,
  vault,
}: {
  clientId: string;
  vault: BrandVault | null;
}) {
  const [state, setState] = useState<BrandVaultInput>(() => ({
    businessDescription: vault?.businessDescription ?? "",
    productsServices: vault?.productsServices ?? "",
    icpAudience: vault?.icpAudience ?? "",
    toneOfVoice: vault?.toneOfVoice ?? "",
    contentGuidelines: vault?.contentGuidelines ?? "",
    usps: vault?.usps ?? [],
    brandTerms: vault?.brandTerms ?? [],
    bannedWords: vault?.bannedWords ?? [],
    competitors: vault?.competitors ?? [],
    ctaTargets: vault?.ctaTargets ?? [],
    authorPersona: vault?.authorPersona ?? {},
  }));

  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof BrandVaultInput>(
    key: K,
    value: BrandVaultInput[K],
  ): void {
    setState((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function save(): void {
    setError(null);
    startTransition(async () => {
      const result = await saveBrandVault(clientId, state);
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What the business is</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Business description"
            hint="Two to four sentences. This anchors every article's framing."
          >
            <Textarea
              rows={3}
              value={state.businessDescription}
              onChange={(e) => set("businessDescription", e.target.value)}
              placeholder="Acme Supply sells industrial fasteners to mid-size manufacturers…"
            />
          </Field>

          <Field
            label="What they sell"
            hint="Be specific — categories, product lines, price points. Keyword scoring uses this to judge which terms can actually convert."
          >
            <Textarea
              rows={3}
              value={state.productsServices}
              onChange={(e) => set("productsServices", e.target.value)}
            />
          </Field>

          <Field
            label="Audience"
            hint="Who buys, what they already know, what they are worried about."
          >
            <Textarea
              rows={3}
              value={state.icpAudience}
              onChange={(e) => set("icpAudience", e.target.value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How they sound</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Tone of voice"
            hint="Register, person, sentence style. Quote a real line from their site if you have one — examples beat adjectives."
          >
            <Textarea
              rows={3}
              value={state.toneOfVoice}
              onChange={(e) => set("toneOfVoice", e.target.value)}
              placeholder="Direct and technical. Second person. Short sentences. Never markety…"
            />
          </Field>

          <ListField
            label="Differentiators"
            hint="What they can claim that competitors cannot."
            values={state.usps}
            onChange={(v) => set("usps", v)}
            placeholder="Same-day dispatch from three UK warehouses"
          />

          <ListField
            label="Brand terms"
            hint="Product names and terms of art, spelled exactly as they should appear."
            values={state.brandTerms}
            onChange={(v) => set("brandTerms", v)}
            placeholder="FastenPro™"
          />

          <ListField
            label="Banned words"
            hint="Never appear in an article. Checked during the revision pass."
            values={state.bannedWords}
            onChange={(v) => set("bannedWords", v)}
            placeholder="cutting-edge"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Competition and links</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ListField
            label="Competitors"
            hint="Domains. Content gap analysis compares their rankings against the client's."
            values={state.competitors}
            onChange={(v) => set("competitors", v)}
            placeholder="competitor.com"
          />

          <div className="space-y-2">
            <Label>Money pages</Label>
            <p className="text-xs text-muted-foreground">
              Articles link internally to these. Say when each one is the right
              destination so links land where they help.
            </p>

            {state.ctaTargets.map((target, index) => (
              <div
                key={index}
                className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_auto]"
              >
                <Input
                  value={target.label}
                  placeholder="Pricing"
                  onChange={(e) => {
                    const next = [...state.ctaTargets];
                    next[index] = { ...target, label: e.target.value };
                    set("ctaTargets", next);
                  }}
                />
                <Input
                  value={target.url}
                  placeholder="https://acme.com/pricing"
                  onChange={(e) => {
                    const next = [...state.ctaTargets];
                    next[index] = { ...target, url: e.target.value };
                    set("ctaTargets", next);
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove"
                  onClick={() =>
                    set(
                      "ctaTargets",
                      state.ctaTargets.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Trash2 />
                </Button>
                <Input
                  className="sm:col-span-3"
                  value={target.useWhen ?? ""}
                  placeholder="Link when the reader is comparing costs"
                  onChange={(e) => {
                    const next = [...state.ctaTargets];
                    next[index] = { ...target, useWhen: e.target.value };
                    set("ctaTargets", next);
                  }}
                />
              </div>
            ))}

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                set("ctaTargets", [
                  ...state.ctaTargets,
                  { label: "", url: "", useWhen: "" },
                ])
              }
            >
              <Plus />
              Add money page
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Author and house rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Articles are bylined to this persona and the credentials go into the
            schema markup — that is the E-E-A-T signal.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Author name">
              <Input
                value={state.authorPersona.name ?? ""}
                onChange={(e) =>
                  set("authorPersona", {
                    ...state.authorPersona,
                    name: e.target.value,
                  })
                }
              />
            </Field>
            <Field label="Job title">
              <Input
                value={state.authorPersona.title ?? ""}
                onChange={(e) =>
                  set("authorPersona", {
                    ...state.authorPersona,
                    title: e.target.value,
                  })
                }
              />
            </Field>
          </div>

          <Field label="Author bio">
            <Textarea
              rows={2}
              value={state.authorPersona.bio ?? ""}
              onChange={(e) =>
                set("authorPersona", {
                  ...state.authorPersona,
                  bio: e.target.value,
                })
              }
            />
          </Field>

          <Field
            label="Content guidelines"
            hint="Client-specific rules. These override the global SEO playbook where they conflict."
          >
            <Textarea
              rows={5}
              value={state.contentGuidelines}
              onChange={(e) => set("contentGuidelines", e.target.value)}
              placeholder="Never mention competitors by name. Always use metric units. UK English."
            />
          </Field>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-background/85 py-3 backdrop-blur">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {saved ? (
          <span className="flex items-center gap-1 text-sm text-success">
            <Check className="size-4" />
            Saved
          </span>
        ) : null}
        <Button onClick={save} disabled={pending}>
          {pending ? <Spinner /> : <Save />}
          Save brand vault
        </Button>
      </div>
    </div>
  );
}

/** Tag-style editor for the several string-array fields on this form. */
function ListField({
  label,
  hint,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit(): void {
    const value = draft.trim();
    if (!value || values.includes(value)) {
      setDraft("");
      return;
    }
    onChange([...values, value]);
    setDraft("");
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}

      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 pb-1">
          {values.map((value) => (
            <li key={value}>
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v !== value))}
                className="group inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs transition-colors hover:border-destructive/40 hover:text-destructive"
              >
                {value}
                <Trash2 className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <Input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Enter must not submit an enclosing form — this is an inline editor.
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}
