import React from 'react';

const ALLOWED_TAGS = new Set([
  'P',
  'BR',
  'STRONG',
  'B',
  'EM',
  'I',
  'U',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'H3',
  'H4',
]);

type DescriptionOptions = {
  onTimecode?: (seconds: number) => void;
};

function timecodeSeconds(value: string): number | null {
  const parts = value
    .replace(/[\[\]]/g, '')
    .split(':')
    .map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function cleanPodcastDescription(text: string): string {
  if (!text) return '';
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    } catch {
      // Fall through to the bounded text-only fallback.
    }
  }
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderPodcastDescription(
  text: string,
  options: DescriptionOptions = {},
): React.ReactNode {
  if (!text) return null;
  if (typeof DOMParser === 'undefined') return cleanPodcastDescription(text);
  try {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const renderText = (value: string, key: string): React.ReactNode => {
      if (!options.onTimecode) return value;
      const codePattern = /\[(?:(?:\d{1,3}:)?\d{1,3}:\d{2})\]/g;
      const nodes: React.ReactNode[] = [];
      let cursor = 0;
      let match: RegExpExecArray | null;
      while ((match = codePattern.exec(value))) {
        if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
        const seconds = timecodeSeconds(match[0]);
        if (seconds === null) nodes.push(match[0]);
        else {
          nodes.push(
            React.createElement(
              'button',
              {
                key: `${key}-time-${match.index}`,
                type: 'button',
                className: 'podcast-timecode',
                title: `跳转到 ${match[0]}`,
                onClick: () => options.onTimecode?.(seconds),
              },
              match[0],
            ),
          );
        }
        cursor = match.index + match[0].length;
      }
      if (!nodes.length) return value;
      if (cursor < value.length) nodes.push(value.slice(cursor));
      return nodes;
    };
    const renderNode = (node: ChildNode, key: string): React.ReactNode => {
      if (node.nodeType === Node.TEXT_NODE) return renderText(node.textContent || '', key);
      if (!(node instanceof HTMLElement)) return null;
      const children = Array.from(node.childNodes).map((child, index) =>
        renderNode(child, `${key}-${index}`),
      );
      const tag = node.tagName.toUpperCase();
      if (tag === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href)) {
          return React.createElement(
            'a',
            { key, href, target: '_blank', rel: 'noreferrer' },
            children,
          );
        }
        return children;
      }
      if (!ALLOWED_TAGS.has(tag)) return children;
      if (tag === 'BR') return React.createElement('br', { key });
      return React.createElement(tag.toLowerCase(), { key }, children);
    };
    return Array.from(doc.body.childNodes).map((node, index) =>
      renderNode(node, `description-${index}`),
    );
  } catch {
    return cleanPodcastDescription(text);
  }
}
