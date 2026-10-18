import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';

type Action = {
  label: string;
  icon: Parameters<typeof Icon>[0]['name'];
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
};

/** One compact menu for pointer, touch and keyboard users. */
export function RowMenu({
  label,
  actions,
  children,
  className = '',
  disabled = false,
}: {
  label: string;
  actions: Action[];
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    origin = useRef({ x: 0, y: 0 }),
    held = useRef(false);
  const cancelHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancelHold, []);
  useEffect(() => {
    if (!position) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setPosition(null);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        setPosition(null);
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = [
          ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
        ];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[
          (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }
    };
    const close = () => setPosition(null);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keyboard);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [position]);
  return (
    <div
      className={`row-with-menu ${className}`}
      onContextMenu={(event) => {
        if (disabled) return;
        event.preventDefault();
        setPosition({ x: event.clientX, y: event.clientY });
      }}
      onPointerDown={(event) => {
        if (disabled || event.pointerType === 'mouse') return;
        cancelHold();
        held.current = false;
        origin.current = { x: event.clientX, y: event.clientY };
        timer.current = setTimeout(() => {
          held.current = true;
          setPosition(origin.current);
        }, 500);
      }}
      onPointerMove={(event) => {
        if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 10)
          cancelHold();
      }}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      onClickCapture={(event) => {
        if (held.current) {
          held.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {children}
      <button
        ref={trigger}
        type="button"
        className="row-menu-trigger icon-button"
        aria-label={`${label}的更多操作`}
        aria-haspopup="menu"
        aria-expanded={!!position}
        disabled={disabled}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition(position ? null : { x: rect.right - 216, y: rect.bottom + 4 });
        }}
      >
        <Icon name="more" />
      </button>
      {position &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={`${label}的操作`}
            className="row-action-menu"
            style={{
              left: Math.max(8, Math.min(position.x, window.innerWidth - 224)),
              top: Math.max(8, Math.min(position.y, window.innerHeight - actions.length * 44 - 24)),
            }}
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                className={action.danger ? 'destructive' : ''}
                disabled={action.disabled}
                onClick={() => {
                  setPosition(null);
                  action.run();
                }}
              >
                <Icon name={action.icon} />
                {action.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
