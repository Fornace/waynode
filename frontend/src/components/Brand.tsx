interface BrandProps {
  size?: number;
  spin?: boolean;        // gently rotate the hub (loading/idle flourish)
  className?: string;
}

/** The Waynode mark: a central node with four radiating paths/ways. */
export function WaynodeMark({ size = 28, spin = false, className = "" }: BrandProps) {
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
      <g fill="var(--accent, #3b82f6)" style={spin ? { transformOrigin: "center", animation: "wn-spin 8s linear infinite" } : undefined}>
        <rect x="29" y="11" width="6" height="15" rx="3" />
        <rect x="29" y="38" width="6" height="15" rx="3" />
        <rect x="11" y="29" width="15" height="6" rx="3" />
        <rect x="38" y="29" width="15" height="6" rx="3" />
        <rect x="25" y="25" width="14" height="14" rx="4" />
      </g>
      <g fill="#e0f2fe">
        <circle cx="32" cy="11" r="5" />
        <circle cx="32" cy="53" r="5" />
        <circle cx="11" cy="32" r="5" />
        <circle cx="53" cy="32" r="5" />
      </g>
    </svg>
  );
}
