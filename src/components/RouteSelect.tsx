import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { FlightRoute } from '../lib/workspace';

export const routeSelection = (route: FlightRoute) => [...(route.folderPath ?? []).map(folder => folder.name), route.name].join(' / ');

type Props = {
  id: string;
  label: string;
  routes: FlightRoute[];
  value: string;
  placeholder: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
};
type Folder = { key: string; name: string; children: Folder[]; routes: FlightRoute[] };
function routeTree(routes: FlightRoute[]) {
  const root: Folder = { key: '', name: '', children: [], routes: [] };
  for (const route of routes) {
    let parent = root;
    for (const folder of route.folderPath?.length ? route.folderPath : [{ id: '__legacy__', name: '未同步文件夹' }]) {
      const key = `${parent.key}/${folder.id}`;
      let child = parent.children.find(item => item.key === key);
      if (!child) { child = { key, name: folder.name, children: [], routes: [] }; parent.children.push(child); }
      parent = child;
    }
    parent.routes.push(route);
  }
  return root.children;
}
const Chevron = () => <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>;
const FolderIcon = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 6V4.5h6l2 2h7V16h-15Z" /></svg>;

export function RouteSelect({ id, label, routes, value, placeholder, disabled, onValueChange }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 320 });
  const folders = routeTree(routes);
  const missing = Boolean(value && !routes.some(route => routeSelection(route) === value));
  const unavailable = disabled || !routes.length;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const toggle = (key: string) => setCollapsed(previous => {
    const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const below = window.innerHeight - rect.bottom - 18;
      const above = rect.top - 18;
      const maxHeight = Math.max(80, Math.min(320, Math.max(below, above)));
      const height = Math.min(popup.current?.scrollHeight ?? maxHeight, maxHeight);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12)), width: rect.width,
        top: below >= height ? rect.bottom + 6 : Math.max(12, rect.top - height - 6), maxHeight });
    };
    place(); window.addEventListener('resize', place); document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [open, collapsed, routes]);
  useEffect(() => {
    if (!open) return;
    (popup.current?.querySelector('[aria-selected="true"]') as HTMLElement | null ?? popup.current?.querySelector<HTMLElement>('[role="treeitem"]'))?.focus();
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open]);
  useEffect(() => { if (unavailable) setOpen(false); }, [unavailable]);
  const keyboard = (event: KeyboardEvent) => {
    const rows = [...(popup.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const active = event.target as HTMLElement;
    const index = rows.indexOf(active);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { event.preventDefault(); close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault(); if (active.getAttribute('aria-expanded') === 'false') active.click(); else if (active.hasAttribute('aria-expanded')) rows[index + 1]?.focus();
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault(); if (active.getAttribute('aria-expanded') === 'true') active.click();
      else (active.closest('ul[role="group"]')?.previousElementSibling as HTMLElement | null)?.focus();
    }
  };
  const renderFolder = (folder: Folder, level: number) => <li role="none" key={folder.key}>
    <button type="button" role="treeitem" aria-expanded={!collapsed.has(folder.key)} aria-level={level} className="route-tree-folder" onClick={() => toggle(folder.key)}>
      <span className="route-tree-arrow"><Chevron /></span><span className="route-tree-folder-icon"><FolderIcon /></span><span>{folder.name}</span>
    </button>
    {!collapsed.has(folder.key) && <ul role="group" className="route-tree-children">
      {folder.children.map(child => renderFolder(child, level + 1))}
      {folder.routes.map(route => {
        const selection = routeSelection(route);
        return <li role="none" key={route.routeId}><button type="button" role="treeitem" aria-level={level + 1} aria-selected={selection === value} className="route-tree-route" title={selection} onClick={() => { close(); onValueChange(selection); }}>
          <span>{route.name}</span>{selection === value && <span className="route-select-check" aria-hidden="true">✓</span>}
        </button></li>;
      })}
    </ul>}
  </li>;
  return <>
    <button type="button" ref={trigger} id={id} role="combobox" aria-label={label} aria-haspopup="tree" aria-expanded={open} aria-controls={open ? `${id}-tree` : undefined} disabled={unavailable} className="route-select-trigger" data-state={open ? 'open' : 'closed'} title={value || placeholder} onClick={() => setOpen(!open)} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
    }}>
      <span className="route-select-value">{value ? `${value}${missing ? '（需重新同步或选择）' : ''}` : placeholder}</span><span className="route-select-chevron"><Chevron /></span>
    </button>
    {open && !unavailable && createPortal(<div ref={popup} className="route-tree-popup" style={position} onKeyDown={keyboard}>
      {routes.some(route => !route.folderPath?.length) && <p className="route-tree-notice">部分航线缺少文件夹信息，请重新同步航线。</p>}
      <ul role="tree" id={`${id}-tree`} aria-label={label} className="route-tree">{folders.map(folder => renderFolder(folder, 1))}</ul>
    </div>, trigger.current?.closest('dialog') ?? document.body)}
  </>;
}
