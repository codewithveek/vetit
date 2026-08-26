import { annotationGapsDetector } from './annotation-gaps.js';
import { commandPhrasesDetector } from './command-phrases.js';
import { crossServerRefsDetector } from './cross-server-refs.js';
import { descriptionLengthDetector } from './description-length.js';
import { embeddedUrlsDetector } from './embedded-urls.js';
import { exfilParamsDetector } from './exfil-params.js';
import { hiddenBlocksDetector } from './hidden-blocks.js';
import { invisibleUnicodeDetector } from './invisible-unicode.js';
import { lookAlikeCharactersDetector } from './look-alike-characters.js';
import { sensitivePathsDetector } from './sensitive-paths.js';
import type { DetectorDefinition } from '../finding.types.js';

/**
 * The registry, in spec order.
 *
 * Order is fixed on purpose: the runner numbers findings as it goes, so the
 * same manifest always produces the same F-numbers, and a report can be
 * compared with the one before it.
 */
export const DETECTORS: readonly DetectorDefinition[] = [
  hiddenBlocksDetector,
  invisibleUnicodeDetector,
  lookAlikeCharactersDetector,
  commandPhrasesDetector,
  sensitivePathsDetector,
  embeddedUrlsDetector,
  exfilParamsDetector,
  annotationGapsDetector,
  crossServerRefsDetector,
  descriptionLengthDetector,
];

export { annotationGapsDetector } from './annotation-gaps.js';
export { buildToolPointer, excerptAround } from './build-evidence.js';
export { commandPhrasesDetector } from './command-phrases.js';
export { crossServerRefsDetector } from './cross-server-refs.js';
export { descriptionLengthDetector } from './description-length.js';
export { embeddedUrlsDetector } from './embedded-urls.js';
export { exfilParamsDetector } from './exfil-params.js';
export { hiddenBlocksDetector } from './hidden-blocks.js';
export { invisibleUnicodeDetector } from './invisible-unicode.js';
export { lookAlikeCharactersDetector } from './look-alike-characters.js';
export { sensitivePathsDetector } from './sensitive-paths.js';
