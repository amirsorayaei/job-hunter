"use client";

import { OwnerGate } from "@/components/OwnerGate";
import { PageShell } from "@/components/PageShell";
import { AgentScheduleSection } from "@/components/settings/AgentSchedule";

/** The agents' timetable on its own page: what ran, what runs next, today and tomorrow. */
export default function SchedulePage() {
  return (
    <OwnerGate>
      <PageShell title="Schedule" wide>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          <AgentScheduleSection />
        </div>
      </PageShell>
    </OwnerGate>
  );
}
