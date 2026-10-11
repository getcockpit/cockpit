/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in installers built by scripts/package.sh (MR-93). */
  readonly VITE_MR_PACKAGED?: string;
}
