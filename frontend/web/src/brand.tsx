import { useTranslation } from 'react-i18next';

export function Brand() {
  const { t } = useTranslation();
  return (
    <a className="brand" href="/" aria-label={t('brand.home')}>
      <img className="mark" src="/favicon.svg" alt="" aria-hidden="true" width="40" height="44" />
      <span>
        野弦<small>WILDSTRING</small>
      </span>
    </a>
  );
}
