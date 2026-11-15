"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  CalendarCheck,
  CheckCircle2,
  ExternalLink,
  FileText,
  Mail,
  RotateCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { GmailLink } from "@/components/GmailLink";
import { NotWorthIt } from "./NotWorthIt";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/convexError";
import { dateTime, nextStep, TRACK_LABEL, WORK_MODE_LABEL } from "@/lib/roleView";
import { ScoreBadge, StageBadge } from "./badges";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[0.6875rem] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** Everything about one role, and the moves the owner can make on it. */
export function RoleDrawer({ roleId, onClose }: { roleId: Id<"roles"> | null; onClose: () => void }) {
  const data = useQuery(api.roles.get, roleId === null ? "skip" : { roleId });
  const setStage = useMutation(api.roles.setStage);
  const prepare = useMutation(api.roles.prepare);
  const dismiss = useMutation(api.roles.dismiss);
  const restore = useMutation(api.roles.restore);
  const saveNote = useMutation(api.roles.saveNote);
  const retryDraft = useMutation(api.gmail.mutations.retryDraft);
  const draftAnyway = useMutation(api.roles.draftAnyway);
  const [note, setNote] = useState<{ id: string; text: string } | null>(null);

  const run = (label: string, action: () => Promise<unknown>) => {
    void action()
      .then(() => toast.success(label))
      .catch((error: unknown) => toast.error(friendlyError(error)));
  };

  const role = data?.role;
  const noteText = note !== null && note.id === roleId ? note.text : (data?.note ?? "");

  return (
    <Sheet open={roleId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl">
        {role === undefined ? (
          <SheetHeader>
            <SheetTitle>Loading…</SheetTitle>
          </SheetHeader>
        ) : (
          <>
            <SheetHeader className="border-b">
              <div className="flex items-start gap-3 pe-8">
                <ScoreBadge score={role.score} />
                <div className="min-w-0">
                  <SheetTitle className="text-base leading-tight">{role.title}</SheetTitle>
                  <SheetDescription className="mt-0.5">
                    {role.company}
                    {role.knownCompany === true && " · contacted before (different role)"}
                  </SheetDescription>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StageBadge stage={role.stage} />
                <span className="text-xs text-muted-foreground">{nextStep(role)}</span>
              </div>
            </SheetHeader>

            <div className="flex flex-col gap-6 p-4">
              {/* Primary actions, by stage. */}
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="lg">
                  <a href={role.url} target="_blank" rel="noreferrer">
                    <ExternalLink /> Open posting
                  </a>
                </Button>
                {(role.stage === "new" || role.prepState === "failed") && (
                  <Button size="lg" onClick={() => run("Queued for the prep agent", () => prepare({ roleId: role._id, now: Date.now() }))}>
                    <Sparkles /> Prepare
                  </Button>
                )}
                {role.stage === "ready" && role.sentAt === undefined && !role.hasDraft && (
                  <Button size="lg" variant="outline" onClick={() => run("Queued for the prep agent", () => prepare({ roleId: role._id, now: Date.now() }))}>
                    <RotateCcw /> Prepare again
                  </Button>
                )}
                {role.stage === "ready" && role.applyKind === "form" && (
                  <Button size="lg" onClick={() => run("Marked as applied", () => setStage({ roleId: role._id, stage: "applied", now: Date.now() }))}>
                    <CheckCircle2 /> I applied
                  </Button>
                )}
                {(role.stage === "new" || role.stage === "ready" || role.stage === "preparing") && (
                  <NotWorthIt onDismiss={(reason) => run("Moved to Dismissed", () => dismiss({ roleId: role._id, reason, now: Date.now() }))} />
                )}
                {role.stage === "dismissed" && (
                  <Button size="lg" variant="outline" onClick={() => run("Restored", () => restore({ roleId: role._id, now: Date.now() }))}>
                    <RotateCcw /> Restore
                  </Button>
                )}
              </div>

              {(role.stage === "applied" || role.stage === "replied" || role.stage === "interview" || role.stage === "no_response") && (
                <Block title="What happened">
                  <div className="flex flex-wrap gap-2">
                    {role.stage !== "replied" && role.stage !== "interview" && (
                      <Button variant="outline" onClick={() => run("Marked replied", () => setStage({ roleId: role._id, stage: "replied", now: Date.now() }))}>
                        <Mail /> They replied
                      </Button>
                    )}
                    {role.stage !== "interview" && (
                      <Button variant="outline" onClick={() => run("Marked interview", () => setStage({ roleId: role._id, stage: "interview", now: Date.now() }))}>
                        <CalendarCheck /> Interview
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => run("Marked offer", () => setStage({ roleId: role._id, stage: "offer", now: Date.now() }))}>
                      <Sparkles /> Offer
                    </Button>
                    <Button variant="outline" onClick={() => run("Marked rejected", () => setStage({ roleId: role._id, stage: "rejected", now: Date.now() }))}>
                      <XCircle /> Rejected
                    </Button>
                  </div>
                </Block>
              )}

              {role.prepError !== undefined && role.prepState === "failed" && (
                <p className="rounded-md bg-destructive/10 p-3 text-xs text-destructive">{role.prepError}</p>
              )}

              <Block title="Fit">
                <p className="text-xs leading-relaxed">{data?.whyFit}</p>
                {data?.gaps !== undefined && data.gaps.trim() !== "" && (
                  <p className="text-xs leading-relaxed text-muted-foreground">Gaps: {data.gaps}</p>
                )}
                {data !== undefined && data !== null && data.mustHaves.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {data.mustHaves.map((item) => (
                      <span key={item} className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                        {item}
                      </span>
                    ))}
                  </div>
                )}
              </Block>

              <Block title="Details">
                <div className="divide-y divide-border/60">
                  <Row label="Track">{TRACK_LABEL[role.track]}</Row>
                  <Row label="Where">
                    {WORK_MODE_LABEL[role.workMode]} · <span className="text-muted-foreground">{role.remoteWording}</span>
                  </Row>
                  <Row label="Apply by">
                    {role.applyKind === "email" ? `Email to ${role.applyEmail ?? "?"}` : "Form on the posting"}
                  </Row>
                  <Row label="Found">{dateTime(role.foundAt)} via {role.source}</Row>
                  {role.appliedAt !== undefined && <Row label="Applied">{dateTime(role.appliedAt)}</Row>}
                  {role.followUpDraftedAt !== undefined && (
                    <Row label="Follow-up">
                      {role.followUpSentAt !== undefined
                        ? `sent ${dateTime(role.followUpSentAt)}`
                        : `draft in Gmail since ${dateTime(role.followUpDraftedAt)}`}
                    </Row>
                  )}
                  {role.repliedAt !== undefined && <Row label="Replied">{dateTime(role.repliedAt)}</Row>}
                </div>
              </Block>

              {data?.lastReplySnippet !== undefined && (
                <Block title="Latest reply">
                  <blockquote className="rounded-md border-s-2 border-emerald-500/60 bg-muted/40 p-3 text-xs">
                    <p className="mb-1 text-muted-foreground">{data.lastReplyFrom}</p>
                    {data.lastReplySnippet}
                  </blockquote>
                </Block>
              )}

              {(data?.resumeUrl !== undefined || data?.prepSummary !== undefined) && (
                <Block title="Tailored resume">
                  {data?.resumeUrl !== undefined && (
                    <Button asChild variant="outline" className="w-fit">
                      <a href={data.resumeUrl} target="_blank" rel="noreferrer">
                        <FileText /> {data.resumeFilename ?? "Resume PDF"}
                      </a>
                    </Button>
                  )}
                  {data?.folder !== undefined && (
                    <p className="font-mono text-[0.6875rem] text-muted-foreground">Job Hunting/{data.folder}/</p>
                  )}
                  {data?.prepSummary !== undefined && (
                    <pre className="max-h-48 overflow-auto rounded-md bg-muted/50 p-3 text-[0.6875rem] whitespace-pre-wrap">
                      {data.prepSummary}
                    </pre>
                  )}
                </Block>
              )}

              {data?.emailBody !== undefined && (
                <Block title="Email">
                  {role.emailError !== undefined && (
                    <div className="flex flex-col gap-2 rounded-md bg-amber-500/10 p-3 text-xs text-amber-300">
                      <p>{role.emailError}</p>
                      <div className="flex gap-2">
                        {role.emailError.startsWith("The truthfulness check") ? (
                          <Button variant="outline" onClick={() => run("Creating the Gmail draft", () => draftAnyway({ roleId: role._id }))}>
                            Create draft anyway
                          </Button>
                        ) : (
                          !role.hasDraft &&
                          role.sentAt === undefined && (
                            <Button variant="outline" onClick={() => run("Creating the Gmail draft", () => retryDraft({ roleId: role._id }))}>
                              Create draft again
                            </Button>
                          )
                        )}
                      </div>
                    </div>
                  )}
                  <div className="rounded-md border bg-muted/30 p-3 text-xs">
                    <p className="mb-1 text-muted-foreground">To: {role.applyEmail}</p>
                    <p className="mb-2 font-medium">{data.emailSubject}</p>
                    <p className="leading-relaxed whitespace-pre-wrap">{data.emailBody}</p>
                  </div>
                  {role.hasDraft && (
                    <Button asChild variant="outline" className="w-fit">
                      <GmailLink>
                        <Mail /> Open Gmail drafts
                      </GmailLink>
                    </Button>
                  )}
                </Block>
              )}

              <Block title="Notes">
                <Textarea
                  value={noteText}
                  placeholder="Anything to remember about this one"
                  onChange={(event) => setNote({ id: role._id, text: event.target.value })}
                  onBlur={() => {
                    if (note !== null && note.id === role._id && note.text !== (data?.note ?? "")) {
                      run("Note saved", () => saveNote({ roleId: role._id, note: note.text }));
                    }
                  }}
                  rows={3}
                />
              </Block>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
