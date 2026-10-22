/**
 * Verification evidence rendered into a change request description.
 *
 * The mandatory two lines of a QA change request stay first; everything the
 * QA run proved is appended below them so a reviewer can read the evidence
 * without opening the local runtime archive.
 *
 * The evidence is layered, because the three kinds of information a QA run
 * produces are not interchangeable: the acceptance criteria and their
 * results, the behavioural claims behind them, and the environment notes
 * that are not acceptance evidence at all.
 */
import type { UploadedArtifact } from '../../../domain/tracker/types.js';

export interface VerificationCheck {
  command: string;
  expected: string;
  /** What the command actually showed; absent when the run did not report it. */
  actual?: string;
}

export interface VerificationObservation {
  claim: string;
  evidence?: string;
}

export interface VerificationEvidence {
  /** The QA agent's one-sentence verdict. */
  summary?: string;
  /** One entry per acceptance criterion the run re-ran. */
  checks?: VerificationCheck[];
  /** One entry per behavioural claim the run observed. */
  observations?: VerificationObservation[];
  /** Environment facts and caveats; not acceptance evidence. */
  notes?: string;
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
    const withActual = evidence.checks.some(check => check.actual?.trim());
    const rows = withActual
      ? evidence.checks.map(check => `| \`${cell(check.command)}\` | ${cell(check.expected)} | ${cell(check.actual ?? '')} |`)
      : evidence.checks.map(check => `| \`${cell(check.command)}\` | ${cell(check.expected)} |`);
    const header = withActual
      ? ['| Check | Expected | Actual |', '| --- | --- | --- |']
      : ['| Check | Expected |', '| --- | --- |'];
    sections.push(['### Acceptance criteria', '', ...header, ...rows].join('\n'));
  }

  if (evidence.observations?.length) {
    const items = evidence.observations.map(observation => {
      const claim = cell(observation.claim);
      const support = observation.evidence?.trim();
      return support ? `- ${claim} — ${cell(support)}` : `- ${claim}`;
    });
    sections.push(['### Observations', '', ...items].join('\n'));
  }

  if (evidence.artifacts?.length) {
    const links = evidence.artifacts.map(artifact => `- [${artifact.name}](${artifact.url})`);
    sections.push(['### Artifacts', '', ...links].join('\n'));
  }

  const notes = evidence.notes?.trim();
  if (notes) sections.push(['> **Run notes**', `> ${notes.replace(/\n+/g, ' ')}`].join('\n'));

  if (!sections.length) return '';
  return `## Verification Evidence\n\n${sections.join('\n\n')}`;
}
