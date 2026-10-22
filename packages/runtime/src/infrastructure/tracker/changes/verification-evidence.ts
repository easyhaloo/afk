/**
 * Verification evidence rendered into a change request description.
 *
 * The mandatory two lines of a QA change request stay first; everything the
 * QA run proved is appended below them so a reviewer can read the evidence
 * without opening the local runtime archive.
 */
import type { UploadedArtifact } from '../../../domain/tracker/types.js';

export interface VerificationCheck {
  command: string;
  expected: string;
}

export interface VerificationEvidence {
  /** The QA agent's own summary of what it verified. */
  summary?: string;
  /** One entry per acceptance criterion the run re-ran. */
  checks?: VerificationCheck[];
  /** Binary artifacts uploaded to the provider. */
  artifacts?: UploadedArtifact[];
}

/** Escape a table cell so a pipe in a command does not break the table. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Render the evidence section. Returns an empty string when the run proved
 * nothing worth publishing, so the caller can keep the description minimal.
 */
export function renderVerificationEvidence(evidence: VerificationEvidence | undefined): string {
  if (!evidence) return '';
  const sections: string[] = [];

  const summary = evidence.summary?.trim();
  if (summary) sections.push(summary);

  if (evidence.checks?.length) {
    const rows = evidence.checks.map(check => `| \`${cell(check.command)}\` | ${cell(check.expected)} |`);
    sections.push(['| Check | Expected |', '| --- | --- |', ...rows].join('\n'));
  }

  if (evidence.artifacts?.length) {
    const links = evidence.artifacts.map(artifact => `- [${artifact.name}](${artifact.url})`);
    sections.push(['### Artifacts', '', ...links].join('\n'));
  }

  if (!sections.length) return '';
  return `## Verification Evidence\n\n${sections.join('\n\n')}`;
}
