import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { hints, type HelpKey } from './help-content';
import './desktop-help.css';

const QUERY = '(min-width: 761px) and (hover: hover) and (pointer: fine)';
const Desktop = createContext(false);
type Target = { source: HTMLElement; anchor: HTMLElement; owner: HTMLElement; text: string };

function findHelp(target: EventTarget | null): Target | null {
  if (!(target instanceof Element)) return null;
  const field = target.closest('input,select,textarea') as HTMLInputElement | null;
  const label = target.closest('label') || field?.labels?.[0];
  const source =
    target.closest<HTMLElement>('[data-help]') || label?.querySelector<HTMLElement>('[data-help]');
  if (source?.dataset.help)
    return { source, anchor: source, owner: field || source, text: source.dataset.help };
  const button = target.closest<HTMLElement>('button[aria-label],summary[aria-label]');
  // Give icon-only controls the same readable name they already expose to assistive technology.
  if (button && !/[\p{L}]/u.test(button.textContent || '') && button.getAttribute('aria-label'))
    return {
      source: button,
      anchor: button,
      owner: button,
      text: button.getAttribute('aria-label')!,
    };
  return null;
}
function visible(target: Target) {
  return (
    target.source.isConnected &&
    target.anchor.getClientRects().length > 0 &&
    !target.source.closest('[hidden],[inert],[aria-hidden="true"]') &&
    (!target.source.closest('dialog') || target.source.closest('dialog')!.open)
  );
}
function Bubble({
  target,
  id,
  bubble,
}: {
  target: Target;
  id: string;
  bubble: React.RefObject<HTMLDivElement | null>;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = bubble.current;
    if (!el) return;
    if (typeof el.showPopover === 'function') el.showPopover();
    const anchor = target.anchor.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    const left = Math.max(
      12,
      Math.min(width - rect.width - 12, anchor.left + (anchor.width - rect.width) / 2),
    );
    const below = anchor.bottom + 8;
    const top =
      below + rect.height <= height - 12
        ? below
        : Math.max(12, Math.min(height - rect.height - 12, anchor.top - rect.height - 8));
    setPosition({ left, top });
    const owner = target.owner;
    const old = (owner.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    owner.setAttribute('aria-describedby', [...new Set([...old, id])].join(' '));
    return () => {
      const remaining = (owner.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter((value) => value && value !== id);
      if (remaining.length) owner.setAttribute('aria-describedby', remaining.join(' '));
      else owner.removeAttribute('aria-describedby');
    };
  }, [target, id, bubble]);
  return createPortal(
    <div
      ref={bubble}
      id={id}
      role="tooltip"
      popover="manual"
      className={`desktop-help-bubble${target.owner !== target.source ? ' field-help-bubble' : ''}`}
      style={{
        left: position?.left,
        top: position?.top,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {target.text}
    </div>,
    target.source.closest('dialog[open]') || document.body,
  );
}

export function DesktopHelpProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(() => matchMedia(QUERY).matches);
  const [target, setTarget] = useState<Target | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const keyboard = useRef(false);
  const id = `desktop-help-${useId()}`;
  useEffect(() => {
    const media = matchMedia(QUERY);
    const change = () => {
      setEnabled(media.matches);
      setTarget(null);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let leave: ReturnType<typeof setTimeout> | undefined;
    let active: Target | null = null;
    let pending: Target | null = null;
    let focused: Target | null = null;
    let frame: number | undefined;
    let dismissed: HTMLElement | null = null;
    function clearTimers() {
      clearTimeout(timer);
      clearTimeout(leave);
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    }
    function close() {
      clearTimers();
      pending = null;
      active = null;
      setTarget(null);
    }
    function show(next: Target, delay: number) {
      clearTimeout(leave);
      if (next.source === dismissed || !visible(next)) return;
      if (next.source === active?.source) {
        if (next.owner !== active.owner) {
          active = next;
          setTarget(next);
        }
        return;
      }
      if (next.source === pending?.source && delay > 0) return;
      close();
      pending = next;
      timer = setTimeout(() => {
        pending = null;
        if (visible(next)) {
          active = next;
          setTarget(next);
        }
      }, delay);
    }
    function over(event: PointerEvent) {
      if (event.pointerType !== 'mouse') return;
      if (event.target instanceof Node && bubble.current?.contains(event.target)) {
        clearTimeout(leave);
        return;
      }
      const next = findHelp(event.target);
      if (next) {
        focused = null;
        show(next, next.owner === document.activeElement ? 0 : 400);
      }
    }
    function out(event: PointerEvent) {
      if (focused && document.activeElement === focused.owner) return;
      const next = findHelp(event.relatedTarget);
      if (next && (next.source === active?.source || next.source === pending?.source)) return;
      if (next) {
        show(next, next.owner === document.activeElement ? 0 : 400);
        return;
      }
      if (event.relatedTarget instanceof Node && bubble.current?.contains(event.relatedTarget))
        return;
      dismissed = null;
      clearTimeout(timer);
      pending = null;
      clearTimeout(leave);
      leave = setTimeout(close, 160);
    }
    function focus(event: FocusEvent) {
      dismissed = null;
      const next = findHelp(event.target);
      // Opening a dialog by mouse must not show a tip on its automatic focus target.
      if (next && (keyboard.current || active?.source === next.source)) {
        focused = next;
        show(next, 0);
      } else {
        focused = null;
        close();
      }
    }
    function blur() {
      focused = null;
      close();
    }
    function scroll() {
      const next = focused;
      close();
      if (!next || document.activeElement !== next.owner) return;
      frame = requestAnimationFrame(() => {
        const box = next.anchor.getBoundingClientRect();
        if (
          focused === next &&
          box.bottom > 0 &&
          box.top < innerHeight &&
          box.right > 0 &&
          box.left < innerWidth
        )
          show(next, 0);
      });
    }
    function keys(event: KeyboardEvent) {
      if (event.key === 'Tab') keyboard.current = true;
      if (event.key === 'Escape') {
        const shown =
          active && bubble.current?.matches(':popover-open') && visible(active) ? active : null;
        dismissed = (active || pending)?.source || null;
        focused = null;
        close();
        if (shown) {
          event.preventDefault();
          event.stopPropagation();
        }
      } else if (event.key === 'Enter' || event.key === ' ') blur();
      else if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        blur();
    }
    function pointerDown(event: PointerEvent) {
      keyboard.current = false;
      focused = null;
      if (event.pointerType !== 'mouse') {
        close();
        return;
      }
      if (event.target instanceof Node && bubble.current?.contains(event.target)) return;
      close();
    }
    const observer = new MutationObserver(() => {
      if (active && !visible(active)) close();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'inert', 'aria-hidden'],
    });
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('pointerdown', pointerDown);
    window.addEventListener('keydown', keys, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', blur);
    window.addEventListener('blur', blur);
    return () => {
      clearTimers();
      observer.disconnect();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
      document.removeEventListener('pointerdown', pointerDown);
      window.removeEventListener('keydown', keys, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', blur);
      window.removeEventListener('blur', blur);
    };
  }, [enabled]);
  return (
    <Desktop.Provider value={enabled}>
      {children}
      {enabled && target && (
        <Bubble key={id + target.text} target={target} id={id} bubble={bubble} />
      )}
    </Desktop.Provider>
  );
}

export function HelpLabel({ hint, children }: { hint: HelpKey; children: ReactNode }) {
  return (
    <span className="desktop-help-label" data-help={hints[hint]}>
      {children}
      <span className="desktop-help-marker" aria-hidden="true" />
    </span>
  );
}
export function HelpText({
  hint,
  text,
  children,
  className = '',
}: {
  hint?: HelpKey;
  text?: string;
  children: ReactNode;
  className?: string;
}) {
  const enabled = useContext(Desktop);
  return (
    <span
      className={`desktop-help-term ${className}`}
      data-help={hint ? hints[hint] : text}
      tabIndex={enabled && (hint || text) ? 0 : undefined}
    >
      {children}
    </span>
  );
}
