import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

export interface BrandProps {
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export function Brand({ onClick }: BrandProps = {}) {
  const { t } = useTranslation();
  return (
    <a
      className="brand"
      href="/"
      aria-label={t('brand.home')}
      onClick={(event) => {
        if (event.defaultPrevented) return;
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        if (onClick) {
          event.preventDefault();
          onClick(event);
        } else if (window.location.pathname === '/' || window.location.pathname === '') {
          event.preventDefault();
        }
      }}
    >
      <img className="mark" src="/favicon.svg" alt="" aria-hidden="true" width="40" height="44" />
      <span>
        野弦<small>WILDSTRING</small>
      </span>
    </a>
  );
}
