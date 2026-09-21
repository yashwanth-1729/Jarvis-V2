import * as React from "react";
import { ChevronRight, Cloud, HardDrive, KeyRound, MapPin, Palette, Plug, Server } from "lucide-react";

export const SETTINGS_PAGES = [
  { id: "appearance", title: "Appearance", hint: "Light, dark or follow your device", icon: Palette, group: "Make it yours" },
  { id: "location", title: "Location", hint: "Your city for weather and local results", icon: MapPin, group: "Make it yours" },
  { id: "providers", title: "AI & voice", hint: "Provider keys for your assistant", icon: KeyRound, group: "Connections" },
  { id: "connectors", title: "Connected apps", hint: "Google services and MCP tools", icon: Plug, group: "Connections" },
  { id: "sync", title: "Sync & backup", hint: "Choose how your devices share data", icon: Cloud, group: "Connections" },
  { id: "runtime", title: "Assistant connection", hint: "Runtime address and connection test", icon: Server, group: "This device" },
  { id: "device", title: "Local storage", hint: "Manage this device’s saved copy", icon: HardDrive, group: "This device" },
] as const;
export type SettingsPage = typeof SETTINGS_PAGES[number]["id"];

export function SettingsHome({ onOpen }: { onOpen: (page: SettingsPage) => void }) {
  return <div className="pocket-settings-home">
    <p className="pocket-settings-intro">Your assistant.<br /><strong>Your preferences.</strong></p>
    {["Make it yours", "Connections", "This device"].map(group => <section key={group}>
      <h3>{group}</h3>
      <div className="pocket-settings-group glass">{SETTINGS_PAGES.filter(item => item.group === group).map(({ id, title, hint, icon: Icon }) =>
        <button key={id} onClick={() => onOpen(id)}><span className="pocket-setting-icon"><Icon size={20} strokeWidth={1.7} /></span><span><strong>{title}</strong><small>{hint}</small></span><ChevronRight size={18} /></button>
      )}</div>
    </section>)}
  </div>;
}
