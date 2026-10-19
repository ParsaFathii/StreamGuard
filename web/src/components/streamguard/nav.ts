"use client";

// StreamGuard Console — navigation model shared by rail, mobile tabs and shortcuts.
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  Crosshair,
  Database,
  GitMerge,
  HeartPulse,
  LayoutDashboard,
  ListTree,
  Radio,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { SectionId } from "@/lib/store";

export interface NavItem {
  id: SectionId;
  icon: LucideIcon;
  labelKey: string;
  descKey: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "overview", icon: LayoutDashboard, labelKey: "nav.overview", descKey: "navDesc.overview" },
  { id: "events", icon: ListTree, labelKey: "nav.events", descKey: "navDesc.events" },
  { id: "live", icon: Radio, labelKey: "nav.live", descKey: "navDesc.live" },
  { id: "rules", icon: ScrollText, labelKey: "nav.rules", descKey: "navDesc.rules" },
  { id: "detections", icon: Crosshair, labelKey: "nav.detections", descKey: "navDesc.detections" },
  { id: "incidents", icon: AlertTriangle, labelKey: "nav.incidents", descKey: "navDesc.incidents" },
  { id: "investigate", icon: Search, labelKey: "nav.investigate", descKey: "navDesc.investigate" },
  { id: "correlation", icon: GitMerge, labelKey: "nav.correlation", descKey: "navDesc.correlation" },
  { id: "ml", icon: BrainCircuit, labelKey: "nav.ml", descKey: "navDesc.ml" },
  { id: "ai", icon: Sparkles, labelKey: "nav.ai", descKey: "navDesc.ai" },
  { id: "sources", icon: Database, labelKey: "nav.sources", descKey: "navDesc.sources" },
  { id: "health", icon: HeartPulse, labelKey: "nav.health", descKey: "navDesc.health" },
  { id: "audit", icon: Activity, labelKey: "nav.audit", descKey: "navDesc.audit" },
  { id: "settings", icon: Settings, labelKey: "nav.settings", descKey: "navDesc.settings" },
];

/** 4 primary sections on the mobile bottom tab bar (+ "More" sheet). */
export const MOBILE_TAB_IDS: SectionId[] = ["overview", "events", "live", "detections", "incidents"];
