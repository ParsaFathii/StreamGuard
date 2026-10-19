"use client";

// StreamGuard Console — section router (single-page, no URL routing).
import { useUiStore } from "@/lib/store";
import type { SessionUser } from "@/lib/types";
import { OverviewSection } from "./sections/overview-section";
import { EventExplorerSection } from "./sections/event-explorer-section";
import { LiveStreamSection } from "./sections/live-stream-section";
import { RulesSection } from "./sections/rules-section";
import { DetectionsSection } from "./sections/detections-section";
import { IncidentQueueSection } from "./sections/incident-queue-section";
import { InvestigationSection } from "./sections/investigation-section";
import { CorrelationSection } from "./sections/correlation-section";
import { MlSection } from "./sections/ml-section";
import { AiSection } from "./sections/ai-section";
import { SourcesSection } from "./sections/sources-section";
import { HealthSection } from "./sections/health-section";
import { AuditSection } from "./sections/audit-section";
import { SettingsSection } from "./sections/settings-section";

export function SectionRouter({ user }: { user: SessionUser }) {
  const section = useUiStore((s) => s.activeSection);

  switch (section) {
    case "overview":
      return <OverviewSection user={user} />;
    case "events":
      return <EventExplorerSection />;
    case "live":
      return <LiveStreamSection user={user} />;
    case "rules":
      return <RulesSection user={user} />;
    case "detections":
      return <DetectionsSection />;
    case "incidents":
      return <IncidentQueueSection user={user} />;
    case "investigate":
      return <InvestigationSection user={user} />;
    case "correlation":
      return <CorrelationSection />;
    case "ml":
      return <MlSection user={user} />;
    case "ai":
      return <AiSection user={user} />;
    case "sources":
      return <SourcesSection user={user} />;
    case "health":
      return <HealthSection user={user} />;
    case "audit":
      return <AuditSection user={user} />;
    case "settings":
      return <SettingsSection user={user} />;
    default:
      return <OverviewSection />;
  }
}
