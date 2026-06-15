export function ClinicHeroIllustration() {
  return (
    <svg
      viewBox="0 0 560 440"
      role="img"
      aria-label="Medical scheduling illustration"
      className="h-auto w-full"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id="clinic-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1.5" fill="#201050" opacity="0.12" />
        </pattern>
      </defs>

      <rect x="28" y="22" width="414" height="330" rx="42" fill="url(#clinic-dots)" />
      <path d="M183 358c74 23 183 19 255-9" fill="none" stroke="#201050" strokeLinecap="round" strokeWidth="3" opacity="0.08" />

      <g stroke="#201050" strokeLinecap="round" strokeLinejoin="round">
        <path d="M174 86a15 15 0 0 1 15-15h190a15 15 0 0 1 15 15v232a15 15 0 0 1-15 15H189a15 15 0 0 1-15-15Z" fill="#fffdf8" strokeWidth="4" />
        <path d="M247 70v-9a13 13 0 0 1 13-13h48a13 13 0 0 1 13 13v9h19a8 8 0 0 1 8 8v22H220V78a8 8 0 0 1 8-8Z" fill="#fffdf8" strokeWidth="4" />
        <path d="M278 64h12" strokeWidth="4" />

        <circle cx="284" cy="140" r="30" fill="#ffc010" stroke="none" />
        <path d="M284 126v28M270 140h28" stroke="#fffdf8" strokeWidth="7" />

        <path d="M227 194h114M227 221h114M227 248h80M227 275h91" strokeWidth="3" opacity="0.34" />

        <path d="M130 250a12 12 0 0 1 12-12h121a12 12 0 0 1 12 12v116a12 12 0 0 1-12 12H142a12 12 0 0 1-12-12Z" fill="#fffdf8" strokeWidth="4" />
        <path d="M130 274h145" strokeWidth="4" />
        <path d="M161 225v26M244 225v26" strokeWidth="5" />
        <rect x="151" y="297" width="25" height="25" rx="3" fill="#fffdf8" stroke="#ffc010" strokeWidth="3" />
        <rect x="190" y="297" width="25" height="25" rx="3" fill="#fffdf8" stroke="#ffc010" strokeWidth="3" />
        <rect x="229" y="297" width="25" height="25" rx="3" fill="#fffdf8" stroke="#ffc010" strokeWidth="3" />
        <rect x="151" y="337" width="25" height="25" rx="3" fill="#fffdf8" stroke="#ffc010" strokeWidth="3" />
        <rect x="190" y="337" width="25" height="25" rx="3" fill="#fffdf8" stroke="#ffc010" strokeWidth="3" />
        <path d="m231 348 7 7 15-18" fill="none" strokeWidth="4" />

        <path d="M396 146c0 24 1 48 12 67 12 22 32 31 52 25 30-9 41-45 41-74" fill="none" strokeWidth="7" />
        <path d="M396 145v-12M501 164v-12" strokeWidth="7" />
        <circle cx="396" cy="127" r="8" fill="#201050" stroke="none" />
        <circle cx="501" cy="146" r="8" fill="#201050" stroke="none" />
        <path d="M460 238v69c0 31-20 50-48 50h-36" fill="none" strokeWidth="7" />
        <circle cx="354" cy="357" r="19" fill="#ffc010" strokeWidth="7" />
        <circle cx="354" cy="357" r="6" fill="#fffdf8" stroke="none" />
      </g>
    </svg>
  );
}
