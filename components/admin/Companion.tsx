import { useId, type CSSProperties } from "react";

export type CompanionMood = "idle" | "sleepy" | "sad";

/** The router's companion, used as the brand mark and in empty and error states. */
export const COMPANION_NAME = "Hazel";

// ponytail: the one fixed companion. These traits are what Nightlight's FNV-1a
// identity gives for the id "llm-router" (Crowned body, apricot, Hazel); port the
// full body/palette table only if the console ever needs a companion per object.
const fill = "#f2a468";
const shade = "#d9854c";
const ink = "#17161a";
const face = { x: 50, y: 62, gap: 10 };
const gaze = 3;

export function Companion({
  mood = "idle",
  size = 44,
  className = "",
}: {
  mood?: CompanionMood;
  size?: number;
  className?: string;
}) {
  const gradientId = `companion-${useId().replaceAll(":", "")}`;
  const left = face.x + gaze - face.gap;
  const right = face.x + gaze + face.gap;
  const style = { "--bot-tilt": "-2deg", "--bot-blink-delay": "2.1s" } as CSSProperties;
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`bot shrink-0 overflow-visible ${className}`}
      data-mood={mood}
      style={style}
      role="img"
      aria-label={COMPANION_NAME}
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="34"
          y1="12"
          x2="66"
          y2="92"
        >
          <stop offset="0" stopColor={fill} />
          <stop offset="1" stopColor={shade} />
        </linearGradient>
      </defs>
      <g className="bot-body">
        <path d="M30 42 33 18l10 12 7-16 7 16 10-12 3 24Z" fill={shade} strokeLinejoin="round" />
        <circle cx="50" cy="60" r="28" fill={`url(#${gradientId})`} />
        {mood === "sleepy" ? (
          <g fill="none" stroke={ink} strokeWidth="3.2" strokeLinecap="round">
            <path d={`M${left - 4} ${face.y}q4 4 8 0`} />
            <path d={`M${right - 4} ${face.y}q4 4 8 0`} />
          </g>
        ) : (
          <g className="bot-eyes" fill={ink}>
            {[left, right].map((x) => (
              <ellipse
                key={x}
                cx={x}
                cy={face.y + (mood === "sad" ? 2.5 : 0)}
                rx="4.3"
                ry={mood === "sad" ? 4.6 : 6.2}
                transform={`rotate(${gaze * 2.5} ${x} ${face.y})`}
              />
            ))}
          </g>
        )}
      </g>
    </svg>
  );
}
