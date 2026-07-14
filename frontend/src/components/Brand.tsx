interface BrandProps {
  size?: number;
  tension?: boolean;
  className?: string;
}

/** The Waynode mark: a connected W, shared with the app icon and favicon. */
export function WaynodeMark({ size = 28, tension = false, className = "" }: BrandProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Waynode"
    >
      <g className={tension ? "wn-tension" : undefined}>
        <g className="wn-links" fill="none" stroke="var(--accent, #60a5fa)" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 23 24 50 32 15 45 50 55 11" strokeWidth="4" />
          <path d="m11 23 12 7 9-15 13 12 10-16" strokeWidth="3.2" opacity=".8" />
          <path d="m24 50 8-13 13 13" strokeWidth="3.2" opacity=".82" />
        </g>
        <g className="wn-nodes" fill="#dbeafe" stroke="var(--accent, #60a5fa)" strokeWidth="1.5">
          {[[11, 23, 4], [23, 30, 4], [32, 15, 4.5], [45, 27, 4], [55, 11, 4.5], [24, 50, 4.5], [32, 37, 4.5], [45, 50, 4.5]].map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      </g>
    </svg>
  );
}
