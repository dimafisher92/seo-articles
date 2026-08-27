/// <reference types="next" />
/// <reference types="next/image-types/global" />

// Next injects CSS module typings during `next dev`/`next build`; a bare
// `tsc --noEmit` does not see them, so the side-effect import is declared here.
declare module "*.css";
