import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="assistant-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={['img', 'input']}
        urlTransform={(url) => {
          try {
            const parsed = new URL(url);
            return ['http:', 'https:'].includes(parsed.protocol) &&
              !parsed.username &&
              !parsed.password
              ? url
              : '';
          } catch {
            return '';
          }
        }}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          table: ({ children }) => (
            <div className="assistant-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
