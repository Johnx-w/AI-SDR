export function TrendChart({ period = '14' }: { period?: string }) {
  const base =
    period === '7'
      ? [42, 61, 49, 85, 73, 110, 96]
      : period === '30'
        ? [28, 43, 39, 64, 45, 72, 62, 90, 74, 101, 86, 114, 98, 128]
        : [32, 48, 39, 68, 57, 81, 67, 94, 79, 107, 87, 118, 104, 132];
  const points = base.map((value, index) => [48 + index * (644 / (base.length - 1)), 190 - value]);
  const curve = points
    .map((point, index) => `${index ? 'L' : 'M'}${point[0]},${point[1]}`)
    .join(' ');
  const second = points
    .map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y + 38 + (index % 3) * 5}`)
    .join(' ');
  return (
    <svg
      className="trend-chart"
      viewBox="0 0 720 235"
      role="img"
      aria-label={`最近${period}天的演示获客趋势，不代表真实 n8n 执行数据`}
    >
      <defs>
        <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4b8d6c" stopOpacity=".2" />
          <stop offset="100%" stopColor="#4b8d6c" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[40, 80, 120, 160, 200].map((y, index) => (
        <g key={y}>
          <line x1="48" x2="695" y1={y} y2={y} stroke="#edf0ed" strokeDasharray="3 5" />
          <text x="29" y={y + 4} textAnchor="end" fill="#9a9e97" fontSize="10">
            {160 - index * 40}
          </text>
        </g>
      ))}
      <path d={`${curve} L692,200 L48,200Z`} fill="url(#trend-fill)" />
      <path
        d={second}
        fill="none"
        stroke="#b6c89b"
        strokeWidth="2"
        strokeDasharray="5 5"
        strokeLinejoin="round"
      />
      <path
        d={curve}
        fill="none"
        stroke="#36775a"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx="692"
        cy={190 - base.at(-1)!}
        r="4"
        fill="#36775a"
        stroke="white"
        strokeWidth="2"
      />
      {['起始日', '第 3 天', '第 5 天', '第 7 天', '第 10 天', '最近'].map((text, index) => (
        <text key={text} x={48 + index * 128} y="226" fill="#9a9e97" fontSize="10">
          {text}
        </text>
      ))}
    </svg>
  );
}
