"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DISMISS_REASONS } from "@/lib/roleView";

/**
 * "Not worth it": moves a role to Dismissed (never deletes it, so the collector
 * cannot bring it back) and optionally records why. Restore is in the role panel.
 */
export function NotWorthIt({
  onDismiss,
  variant = "label",
}: {
  onDismiss: (reason: string | undefined) => void;
  variant?: "label" | "icon";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "icon" ? (
          <Button size="icon-sm" variant="ghost" aria-label="Not worth it" title="Not worth it">
            <X />
          </Button>
        ) : (
          <Button size="lg" variant="outline">
            <X /> Not worth it
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Why? (optional)</DropdownMenuLabel>
        {DISMISS_REASONS.map((reason) => (
          <DropdownMenuItem key={reason} onSelect={() => onDismiss(reason)}>
            {reason}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onDismiss(undefined)}>Just remove it</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
