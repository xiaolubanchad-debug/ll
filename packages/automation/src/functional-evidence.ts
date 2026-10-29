import { functionalEvidenceText } from '@apk/contracts';
import type { FunctionalEvidence } from '@apk/contracts';
import { canonical, sha } from './common.js';
import { RegistrationError } from './registration-types.js';
import {
  controlLocator,
  readRegistrationPage,
  registrationEntries,
  registrationForm,
} from './registration-ui.js';

export function functionalEvidence(
  source: string,
  pkg: string,
  result?: { outcome: 'SUCCEEDED' | 'FAILED'; automatic: boolean },
): Buffer {
  const page = readRegistrationPage(source, pkg);
  if (page.foreign) throw new RegistrationError('EVIDENCE_UNSAFE');
  const controls: FunctionalEvidence['controls'] = [];
  const add = (
    role: FunctionalEvidence['controls'][number]['role'],
    rect: FunctionalEvidence['controls'][number]['rect'],
  ) => {
    if (
      controls.length < 64 &&
      !controls.some((c) => c.role === role && canonical(c.rect) === canonical(rect))
    )
      controls.push({ role, rect: { ...rect } });
  };
  try {
    for (const entry of registrationEntries(page, pkg)) add(entry.role, entry.rect);
    const form = registrationForm(page, pkg);
    if (form) {
      for (const [role, locator] of [
        ['USERNAME', form.username],
        ['PASSWORD', form.password],
        ['PASSWORD_CONFIRM', form.confirm],
        ['REGISTER', form.submit],
        ['CONSENT', form.agreement],
      ] as const) {
        if (!locator) continue;
        for (const c of page.controls) {
          try {
            if (canonical(controlLocator(c, page)) === canonical(locator)) add(role, c.rect);
          } catch {
            /* Ambiguous controls are omitted, never guessed. */
          }
        }
      }
    }
  } catch {
    /* A diagnostic structure is optional; it cannot alter the actual UI outcome. */
  }
  return Buffer.from(
    functionalEvidenceText({
      schemaVersion: '1.0',
      kind: 'FUNCTIONAL_EVIDENCE',
      stage: result ? 'RESULT' : 'DISCOVERY',
      outcome: result?.outcome ?? 'UNVERIFIED',
      verification: result
        ? result.automatic
          ? 'AUTO_EXPLICIT_UI'
          : 'CONFIGURED_LOCATOR'
        : 'NO_SUBMISSION',
      sourceDigest: sha(source),
      controls,
    }),
    'utf8',
  );
}
