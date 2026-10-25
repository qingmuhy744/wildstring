import type { ButtonHTMLAttributes } from 'react';
import { Icon } from './icons';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> & {
  'aria-label': string;
};

export function DialogCloseButton({ className = '', ...props }: Props) {
  return (
    <button {...props} type="button" className={`dialog-close ${className}`}>
      <Icon name="close" />
    </button>
  );
}
