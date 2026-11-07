import { useEffect, useRef, type ReactNode, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './icons';

export type SettingsCategory = {
  id: string;
  label: string;
  description: string;
  icon: ComponentProps<typeof Icon>['name'];
};

export function SettingsLayout({
  title,
  categories,
  selected,
  onSelect,
  onBack,
  children,
}: {
  title: string;
  categories: SettingsCategory[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onBack: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  const category = categories.find((item) => item.id === selected);
  useEffect(() => {
    heading.current?.focus();
    window.scrollTo(0, 0);
  }, [selected]);
  return (
    <section className={`settings-center${category ? ' has-category' : ''}`} aria-label={title}>
      <header className="settings-page-header">
        <button
          className="text-button settings-back"
          onClick={() => (category ? onSelect(null) : onBack())}
        >
          <span aria-hidden="true">←</span>{' '}
          {category ? t('settings.backCategories') : t('settings.backMusic')}
        </button>
        <div className="settings-page-heading">
          <div>
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
          </div>
        </div>
      </header>
      {!category ? (
        <nav className="settings-directory" aria-label={t('settings.categories')}>
          {categories.map((item) => (
            <button key={item.id} onClick={() => onSelect(item.id)}>
              <span className="settings-category-icon">
                <Icon name={item.icon} />
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              <Icon name="chevron" />
            </button>
          ))}
        </nav>
      ) : (
        <div className="settings-columns">
          <nav className="settings-category-nav" aria-label={t('settings.categories')}>
            {categories.map((item) => (
              <button
                key={item.id}
                aria-current={selected === item.id ? 'page' : undefined}
                onClick={() => onSelect(item.id)}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <section className="settings-content" aria-label={category.label}>
            <header className="settings-content-heading">
              <h2>{category.label}</h2>
            </header>
            {children}
          </section>
        </div>
      )}
    </section>
  );
}
