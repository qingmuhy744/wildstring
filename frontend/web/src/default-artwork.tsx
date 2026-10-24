import type { CSSProperties } from 'react';

// 精心调配的 8 组复古黑胶暗调色彩，赋予每张没有封面的专辑专属的高级质感
const VINYL_PALETTES = [
  { name: 'obsidian', from: '#242728', to: '#121415', label: '#993d3d', text: '#f3ece1' },
  { name: 'whiskey', from: '#3d2817', to: '#1a1007', label: '#b87333', text: '#fdedd6' },
  { name: 'emerald', from: '#162b21', to: '#0a1610', label: '#2d6a4f', text: '#e8f5e9' },
  { name: 'midnight', from: '#152438', to: '#09111c', label: '#2b5282', text: '#e2edfa' },
  { name: 'bordeaux', from: '#381621', to: '#17070b', label: '#85243b', text: '#fae3ea' },
  { name: 'twilight', from: '#281a38', to: '#11081a', label: '#593278', text: '#f3e8fa' },
  { name: 'slate', from: '#222d33', to: '#0e1417', label: '#415a6b', text: '#e6f0f5' },
  { name: 'amber', from: '#382214', to: '#190d06', label: '#9c5324', text: '#faecd9' },
];

function getPalette(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % VINYL_PALETTES.length;
  return VINYL_PALETTES[index];
}

export function DefaultArtwork({
  title = '',
  artist = '',
  className = '',
  style,
  interactive = false,
}: {
  title?: string;
  artist?: string;
  className?: string;
  style?: CSSProperties;
  interactive?: boolean;
}) {
  const cleanTitle = title.trim() || 'WildString';
  const palette = getPalette(cleanTitle);

  // 首字提取：过滤括号与标点，取第一个有意义的中英文或数字字符
  const matchedChar = cleanTitle.replace(/^[《〈（(【[\s_.-]+/, '').trim();
  const initialChar = Array.from(matchedChar)[0] || '♪';

  return (
    <div
      className={`default-artwork-jacket ${className}`}
      style={{
        ...style,
        background: `radial-gradient(circle at 50% 40%, ${palette.from} 0%, ${palette.to} 100%)`,
      }}
      aria-hidden="true"
    >
      <svg
        className="default-artwork-svg"
        viewBox="0 0 300 300"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id={`vinyl-grad-${palette.name}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0a0b0c" />
            <stop offset="55%" stopColor="#181a1c" />
            <stop offset="70%" stopColor="#101112" />
            <stop offset="88%" stopColor="#1a1c1e" />
            <stop offset="100%" stopColor="#080809" />
          </radialGradient>
          <linearGradient id="sheen" x1="0" y1="0" x2="300" y2="300" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.08" />
            <stop offset="45%" stopColor="#ffffff" stopOpacity="0.01" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="0.12" />
            <stop offset="55%" stopColor="#ffffff" stopOpacity="0.01" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.06" />
          </linearGradient>
        </defs>

        {/* 实体封套微纹边框 */}
        <rect
          x="1"
          y="1"
          width="298"
          height="298"
          rx="12"
          stroke="rgba(255, 255, 255, 0.12)"
          strokeWidth="1.5"
          fill="none"
        />

        {/* 黑胶盘片本体 */}
        <g transform="translate(150, 150)">
          {/* 黑胶基底 */}
          <circle r="128" fill={`url(#vinyl-grad-${palette.name})`} stroke="#000" strokeWidth="2" />
          {/* 唱片微光同心凹槽 (Grooves) */}
          <circle r="120" stroke="rgba(255,255,255,0.04)" strokeWidth="1" fill="none" />
          <circle r="112" stroke="rgba(0,0,0,0.6)" strokeWidth="1.5" fill="none" />
          <circle r="104" stroke="rgba(255,255,255,0.03)" strokeWidth="0.8" fill="none" />
          <circle r="96" stroke="rgba(0,0,0,0.5)" strokeWidth="1.2" fill="none" />
          <circle r="88" stroke="rgba(255,255,255,0.04)" strokeWidth="0.8" fill="none" />
          <circle r="80" stroke="rgba(0,0,0,0.6)" strokeWidth="1.5" fill="none" />
          <circle r="72" stroke="rgba(255,255,255,0.03)" strokeWidth="0.8" fill="none" />

          {/* 黑胶盘面拟真高光放射 */}
          <circle r="128" fill="url(#sheen)" />

          {/* 唱片中心标签贴纸 (Label) */}
          <circle r="52" fill={palette.label} stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
          <circle r="48" stroke="rgba(0,0,0,0.25)" strokeWidth="1" fill="none" />

          {/* 中心主首字艺术字 */}
          <text
            y="7"
            textAnchor="middle"
            fill={palette.text}
            fontSize="32"
            fontWeight="bold"
            fontFamily="Georgia, 'Songti SC', serif"
            style={{ letterSpacing: '1px' }}
          >
            {initialChar}
          </text>

          {/* 标签上方弧形/微文字 */}
          <text
            y="-32"
            textAnchor="middle"
            fill="rgba(255,255,255,0.65)"
            fontSize="7"
            fontWeight="600"
            letterSpacing="2px"
          >
            WILDSTRING
          </text>
          <text
            y="35"
            textAnchor="middle"
            fill="rgba(255,255,255,0.65)"
            fontSize="6.5"
            fontWeight="500"
            letterSpacing="1px"
          >
            HI-FI VINYL
          </text>

          {/* 唱机中心插孔 */}
          <circle r="6" fill="#0c0d0e" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
        </g>

        {/* 封套顶部与底部优雅标识 */}
        <g transform="translate(16, 26)">
          <text
            fill="rgba(255, 255, 255, 0.45)"
            fontSize="9"
            fontWeight="600"
            letterSpacing="1.5px"
          >
            STEREO
          </text>
        </g>
        <g transform="translate(284, 26)">
          <text
            textAnchor="end"
            fill="rgba(255, 255, 255, 0.45)"
            fontSize="9"
            fontWeight="600"
            letterSpacing="1.5px"
          >
            33⅓ RPM
          </text>
        </g>

        {/* 封套底部信息：专辑与艺人 */}
        <g transform="translate(20, 265)">
          <text
            fill="#ffffff"
            fontSize="13"
            fontWeight="600"
            style={{ textShadow: '0 2px 8px rgba(0,0,0,0.8)' }}
          >
            {cleanTitle.length > 18 ? cleanTitle.slice(0, 17) + '…' : cleanTitle}
          </text>
          {artist && (
            <text
              y="16"
              fill="rgba(255, 255, 255, 0.65)"
              fontSize="10"
              style={{ textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}
            >
              {artist.length > 22 ? artist.slice(0, 21) + '…' : artist}
            </text>
          )}
        </g>
      </svg>
      {interactive && <div className="default-artwork-hint">点击更换封面</div>}
    </div>
  );
}
