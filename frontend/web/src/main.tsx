import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Connection = 'checking' | 'ready' | 'unready' | 'offline';

function App() {
  const [connection, setConnection] = useState<Connection>('checking');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setConnection('offline');
      controller.abort();
    }, 6000);
    setConnection('checking');
    fetch('/health/ready', { signal: controller.signal })
      .then(async (response) => {
        const result: { status?: string } = await response.json();
        if (!controller.signal.aborted) {
          setConnection(response.ok && result.status === 'ok' ? 'ready' : 'unready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setConnection('offline');
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [revision]);

  const labels: Record<Connection, string> = {
    checking: '正在连接音乐服务…',
    ready: '音乐服务已连接',
    unready: '服务已启动，存储尚未就绪',
    offline: '尚未连接音乐服务',
  };

  return (
    <main>
      <header>
        <a className="brand" href="/" aria-label="野弦首页">
          <span className="mark" aria-hidden="true">
            ≋
          </span>
          <span>
            野弦 <small>WILDSTRING</small>
          </span>
        </a>
        <span className="stage">开发预览</span>
      </header>
      <section className="intro" aria-labelledby="title">
        <p className="eyebrow">YOUR MUSIC. A NEW CONVERSATION.</p>
        <h1 id="title">
          你的收藏，
          <br />
          新的<span>回响。</span>
        </h1>
        <p className="description">
          一个从你的私人曲库出发的 AI 音乐播放器。
          <br />
          用一句话找歌，让下一首更懂你。
        </p>
      </section>
      <section className="connection" aria-label="服务连接">
        <div>
          <p className={`status ${connection}`} role="status" aria-live="polite">
            <i aria-hidden="true" />
            {labels[connection]}
          </p>
          <p className="hint">当前为工程初始化版本，曲库导入、播放和 AI 功能正在建设。</p>
        </div>
        <button
          type="button"
          disabled={connection === 'checking'}
          onClick={() => setRevision((n) => n + 1)}
        >
          重新检测 <span aria-hidden="true">↗</span>
        </button>
      </section>
      <footer>
        <span>音乐不设限，自由有回响。</span>
        <span>野弦 · 从自己的音乐开始</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
