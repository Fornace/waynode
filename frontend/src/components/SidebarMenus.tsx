import { useEffect, useRef, useState } from "react";
import type { Org } from "../types";
import { WaynodeMark } from "./Brand";

interface OrgSwitcherProps {
  orgs: Org[];
  activeOrgId: string | null;
  onSelect: (orgId: string) => void;
  onCreate: (name: string) => Promise<void>;
  onToggleSidebar: () => void;
}

export function OrgSwitcher({ orgs, activeOrgId, onSelect, onCreate, onToggleSidebar }: OrgSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeOrg = orgs.find((org) => org.id === activeOrgId);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>(".send-dropdown button")?.focus();
    const closeOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
        setShowInput(false);
      }
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  const create = async () => {
    const nextName = name.trim();
    if (!nextName) return;
    setCreating(true);
    try {
      await onCreate(nextName);
      setName("");
      setShowInput(false);
      setOpen(false);
    } finally {
      setCreating(false);
    }
  };

  return <div className="sidebar-header" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); setShowInput(false); } }}>
    <div ref={ref} style={{ flex: 1, position: "relative" }}>
      <button type="button" className="menu-trigger-row" style={{ fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 8, width: "100%", letterSpacing: "-0.3px", color: "var(--text)" }} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" aria-label="Choose organization">
        <WaynodeMark size={20} /><span>{activeOrg?.name || "Waynode"}</span><span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>▾</span>
      </button>
      {open && <div className="send-dropdown" role="menu" aria-label="Organizations" style={{ position: "absolute", top: "100%", bottom: "auto", left: 0, marginTop: 4 }}>
        {orgs.map((org) => <button key={org.id} role="menuitemradio" aria-checked={org.id === activeOrgId} className="send-dropdown-item" style={org.id === activeOrgId ? { color: "var(--accent)" } : {}} onClick={() => { onSelect(org.id); setOpen(false); }}>
          <div>{org.name}</div>{org.space_count !== undefined && <div className="item-desc">{org.space_count} worktrees</div>}
        </button>)}
        {showInput ? <div style={{ display: "flex", gap: 6, padding: "6px 10px" }}>
          <input className="modal-input" style={{ flex: 1 }} placeholder="Organization name" aria-label="Organization name" autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") create(); if (event.key === "Escape") setShowInput(false); }} />
          <button className="btn-primary" onClick={create} disabled={creating || !name.trim()}>{creating ? "…" : "Add"}</button>
        </div> : <button role="menuitem" className="send-dropdown-item" onClick={() => setShowInput(true)}>New organization</button>}
      </div>}
    </div>
    <button type="button" className="sidebar-collapse-btn icon-btn-ghost" onClick={onToggleSidebar} aria-label="Close worktree navigation">×</button>
  </div>;
}

interface UserMenuProps {
  user: { name: string; email: string | null; avatar_url: string | null };
  isAdmin: boolean;
  onOpenAdmin: () => void;
  onOpenAccountSettings: () => void;
  onLogout: () => void;
}

export function UserMenu({ user, isAdmin, onOpenAdmin, onOpenAccountSettings, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>(".send-dropdown button")?.focus();
    const closeOutside = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);
  const run = (action: () => void) => { setOpen(false); action(); };
  return <div ref={ref} className="sidebar-footer" style={{ position: "relative" }} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); } }}>
    <button type="button" className="menu-trigger-row" onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, textAlign: "left" }} aria-expanded={open} aria-haspopup="menu" aria-label="Open account menu">
      {user.avatar_url && <img className="user-avatar" src={user.avatar_url} alt="" />}<span className="user-name">{user.name}</span>
    </button>
    {open && <div className="send-dropdown" role="menu" aria-label="Account" style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 4 }}>
      <div className="send-dropdown-item" style={{ cursor: "default", opacity: 0.8 }}><div>{user.name}</div>{user.email && <div className="item-desc">{user.email}</div>}</div>
      {isAdmin && <button role="menuitem" className="send-dropdown-item" onClick={() => run(onOpenAdmin)}>Admin</button>}
      <button role="menuitem" className="send-dropdown-item" onClick={() => run(onOpenAccountSettings)}>Account settings</button>
      <button role="menuitem" className="send-dropdown-item" onClick={() => run(onLogout)}>Log out</button>
    </div>}
  </div>;
}

interface SessionMenuItem { label: string; onClick: () => void; danger?: boolean }

export function SessionMenu({ items, onClose }: { items: SessionMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const closeOutside = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose(); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("mousedown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [onClose]);
  return <div className="send-dropdown session-menu" role="menu" aria-label="Session actions" ref={ref} onClick={(event) => event.stopPropagation()}>
    {items.map((item) => <button role="menuitem" key={item.label} className="send-dropdown-item" style={item.danger ? { color: "var(--red)" } : undefined} onClick={() => { item.onClick(); onClose(); }}>{item.label}</button>)}
  </div>;
}
