import React from 'react';

export type OctoIconProps = {
  size?: number;
  className?: string;
  title?: string;
};

function IconBase({
  size = 16,
  className,
  title,
  children,
  viewBox = '0 0 24 24',
}: OctoIconProps & { children: React.ReactNode; viewBox?: string }) {
  const ariaHidden = title ? undefined : true;
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden={ariaHidden}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export function OctoPlus({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

export function OctoX({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M6.5 6.5l11 11M17.5 6.5l-11 11"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

// Broker Harness ("하넷") logo — a symmetric deer antler (사슴뿔) line-art mark.
// Two beams rising from a center base, each forking into tines.
export function OctoAntler({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {/* base where the two antlers meet */}
        <path d="M10.6 20.5c.6.9 2.2.9 2.8 0" />
        {/* left beam */}
        <path d="M10.8 20.2C9.8 16 8.2 14 6.4 12.2" />
        {/* left upper fork */}
        <path d="M6.4 12.2C5.7 10.6 5.6 9.4 5.9 7.9" />
        <path d="M6.4 12.2C5.2 11.6 4.2 11.3 3.2 11.4" />
        {/* left lower tine */}
        <path d="M9 16.2C7.9 15.6 7 15.5 5.9 15.9" />
        {/* right beam */}
        <path d="M13.2 20.2C14.2 16 15.8 14 17.6 12.2" />
        {/* right upper fork */}
        <path d="M17.6 12.2C18.3 10.6 18.4 9.4 18.1 7.9" />
        <path d="M17.6 12.2C18.8 11.6 19.8 11.3 20.8 11.4" />
        {/* right lower tine */}
        <path d="M15 16.2C16.1 15.6 17 15.5 18.1 15.9" />
      </g>
    </IconBase>
  );
}

export function OctoMic({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      <path
        d="M5.5 11a6.5 6.5 0 0 0 13 0"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M12 18v3"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M8.5 21h7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </IconBase>
  );
}

export function OctoStop({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" />
    </IconBase>
  );
}

export function OctoCamera({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M8.5 7.5 10.2 5.8h3.6L15.5 7.5"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="4.5"
        y="7.5"
        width="15"
        height="12"
        rx="3"
        stroke="currentColor"
        strokeWidth="2.1"
      />
      <circle
        cx="12"
        cy="13.5"
        r="3.2"
        stroke="currentColor"
        strokeWidth="2.1"
      />
    </IconBase>
  );
}

export function OctoShell({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <rect
        x="4.5"
        y="6.5"
        width="15"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="2.1"
      />
      <path
        d="M8 10.5 10.5 12.9 8 15.3"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.4 15.3h4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </IconBase>
  );
}

export function OctoSpark({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M12 2.5 13.7 9.3 20.5 12 13.7 14.7 12 21.5 10.3 14.7 3.5 12 10.3 9.3 12 2.5Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <path
        d="M12 6.2v11.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M6.2 12h11.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.55"
      />
    </IconBase>
  );
}

export function OctoSkill({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M6.8 6.4h10.4a2.3 2.3 0 0 1 2.3 2.3v6.6a2.3 2.3 0 0 1-2.3 2.3H6.8a2.3 2.3 0 0 1-2.3-2.3V8.7a2.3 2.3 0 0 1 2.3-2.3Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <path
        d="M9 4.6v3.2M15 4.6v3.2"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M12 9.1 13 11.4l2.5.2-1.9 1.6.6 2.4-2.2-1.3-2.2 1.3.6-2.4-1.9-1.6 2.5-.2 1-2.3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

export function OctoCodex({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4L12 2.8Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <path
        d="M7.8 9.6 12 12l4.2-2.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.8 14.4 12 16.8l4.2-2.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
    </IconBase>
  );
}

export function OctoBot({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M12 4.2v2.2"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <circle
        cx="12"
        cy="3.2"
        r="1.2"
        fill="currentColor"
        opacity="0.9"
      />
      <rect
        x="5.8"
        y="7.2"
        width="12.4"
        height="12"
        rx="3.2"
        stroke="currentColor"
        strokeWidth="2.1"
      />
      <circle cx="10" cy="13" r="1.1" fill="currentColor" />
      <circle cx="14" cy="13" r="1.1" fill="currentColor" />
      <path
        d="M10.2 16.2h3.6"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </IconBase>
  );
}

export function OctoNote({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M7 4.5h8.3l2.7 2.7V19a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 19V7A2.5 2.5 0 0 1 7 4.5Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <path
        d="M15.3 4.5V7a2.5 2.5 0 0 0 2.5 2.5h2.2"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 12h9"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path
        d="M7.5 15.6h7"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.75"
      />
    </IconBase>
  );
}

export function OctoGear({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
      />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinejoin="round"
      />
    </IconBase>
  );
}

export function OctoSliders({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M5.5 7h13"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <circle cx="10" cy="7" r="1.7" fill="currentColor" />
      <path
        d="M5.5 12h13"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <circle cx="15" cy="12" r="1.7" fill="currentColor" />
      <path
        d="M5.5 17h13"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <circle cx="12" cy="17" r="1.7" fill="currentColor" />
    </IconBase>
  );
}

export function OctoLock({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M8.5 11V9.2a3.5 3.5 0 0 1 7 0V11"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <rect
        x="6.5"
        y="11"
        width="11"
        height="10"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="2.1"
      />
      <path
        d="M12 16v2"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.85"
      />
    </IconBase>
  );
}

export function OctoSplitView({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <rect
        x="4.5"
        y="6.5"
        width="15"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="2.1"
      />
      <path
        d="M11.5 6.7v10.6"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.8"
      />
      <path
        d="M7.2 10.6h2.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M7.2 13.4h3.2"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.6"
      />
    </IconBase>
  );
}

export function OctoCopy({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <rect
        x="8"
        y="8"
        width="11"
        height="11"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="2.1"
      />
      <path
        d="M7.3 15.8H6.9a2.4 2.4 0 0 1-2.4-2.4V6.9a2.4 2.4 0 0 1 2.4-2.4h6.5a2.4 2.4 0 0 1 2.4 2.4v.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </IconBase>
  );
}

export function OctoPencil({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M4.8 19.2 5.4 15.6 15.6 5.4a2.1 2.1 0 0 1 3 0l.9.9a2.1 2.1 0 0 1 0 3L9.2 19.5l-3.6.6Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <path
        d="M13.6 7.4 17.6 11.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.8"
      />
    </IconBase>
  );
}

export function OctoTrash({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M5.8 7.6h12.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M9.2 7.6V6.2a1.7 1.7 0 0 1 1.7-1.7h2.2a1.7 1.7 0 0 1 1.7 1.7v1.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <rect
        x="7"
        y="7.6"
        width="10"
        height="13.2"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="2.1"
      />
      <path
        d="M10.2 11v6.4M13.8 11v6.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.85"
      />
    </IconBase>
  );
}

export function OctoPlane({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      <path
        d="M3.8 11.2 20.2 4.6 13.6 21.2l-2.7-7.3-7.1-2.7Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <path
        d="M10.9 13.9 20.2 4.6"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        opacity="0.85"
      />
    </IconBase>
  );
}

/** Octopus (문어) — cute round head + 4 tentacles */
export function OctoOctopus({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      {/* head */}
      <ellipse cx="12" cy="9" rx="6.5" ry="5.8"
        stroke="currentColor" strokeWidth="2" fill="none" />
      {/* left eye */}
      <circle cx="9.4" cy="8.6" r="1" fill="currentColor" />
      {/* right eye */}
      <circle cx="14.6" cy="8.6" r="1" fill="currentColor" />
      {/* smile */}
      <path d="M10 11a2.4 2.4 0 0 0 4 0"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      {/* tentacles */}
      <path d="M6.5 13.5c-1 2-1.8 4.5-.5 5.5"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M9 14.2c-.3 2-.2 4.5 1 5"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M15 14.2c.3 2 .2 4.5-1 5"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M17.5 13.5c1 2 1.8 4.5.5 5.5"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </IconBase>
  );
}

/** Squid (오징어) — elongated body + tentacles + fins */
export function OctoSquid({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      {/* body */}
      <path d="M8.5 4c0-1 7-1 7 0v9c0 1.5-7 1.5-7 0V4Z"
        stroke="currentColor" strokeWidth="1.8" fill="none" />
      {/* fins */}
      <path d="M8.5 6.5C6.5 7 5.5 8.5 6.5 10"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M15.5 6.5c2 .5 3 2 2 3.5"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      {/* eyes */}
      <circle cx="10.5" cy="7.5" r="0.9" fill="currentColor" />
      <circle cx="13.5" cy="7.5" r="0.9" fill="currentColor" />
      {/* tentacles */}
      <path d="M9.5 13.2c-.5 2.5-1.5 4 0 5.3"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M12 13.5c0 2.5-.2 4.5.3 5.8"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M14.5 13.2c.5 2.5 1.5 4 0 5.3"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </IconBase>
  );
}

/** Orchestra conductor baton — for Octo Orchestra mode */
export function OctoBaton({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      {/* baton stick */}
      <path d="M4 20 L17 4"
        stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      {/* baton tip sparkle */}
      <circle cx="18" cy="3.5" r="1.5" fill="currentColor" opacity="0.9" />
      {/* motion arcs */}
      <path d="M14 8c3 1 5 3.5 4.5 7"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.5" />
      <path d="M11 11c3 .8 5.5 3 5.5 6.5"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" opacity="0.35" />
    </IconBase>
  );
}

/** Music notes — for orchestra theme */
export function OctoMusic({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      {/* first note stem + head */}
      <path d="M8 4v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="6" cy="16" r="2.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
      {/* second note stem + head */}
      <path d="M17 3v11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="15" cy="14" r="2.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
      {/* beam connecting */}
      <path d="M8 4 L17 3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M8 7.5 L17 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </IconBase>
  );
}

export function OctoAddRoot({ size, className, title }: OctoIconProps) {
  return (
    <IconBase size={size} className={className} title={title}>
      {/* folder body */}
      <path d="M3 7.5C3 6.12 4.12 5 5.5 5H9l2 2h6.5C18.88 7 20 8.12 20 9.5V17c0 1.38-1.12 2.5-2.5 2.5h-12C4.12 19.5 3 18.38 3 17V7.5z"
        fill="#5b9bd5" stroke="#3a7bc8" strokeWidth="1" />
      {/* plus sign */}
      <path d="M11.5 11v5M9 13.5h5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </IconBase>
  );
}
