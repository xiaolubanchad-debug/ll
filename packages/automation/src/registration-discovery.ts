import type {
  AutoRegistration,
  LearnedRegistrationTemplate,
  RegistrationRecognition,
} from '@apk/contracts';
import { schemaIssues } from '@apk/contracts';
import { PNG } from 'pngjs';
import { canonical, sha } from './common.js';
import type { AndroidSession, Rect } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
import {
  entryRole,
  readRegistrationPage,
  registrationEntries,
  registrationForm,
} from './registration-ui.js';
import type { EntryCandidate, RegistrationForm } from './registration-ui.js';

export interface RegistrationLearning {
  load(key: string): Promise<LearnedRegistrationTemplate | undefined>;
  save(key: string, template: LearnedRegistrationTemplate): Promise<void>;
  drop(key: string): Promise<void>;
}
export interface RegistrationDiscovery {
  form: RegistrationForm;
  template: LearnedRegistrationTemplate;
}
export function validLearnedTemplate(value: unknown): value is LearnedRegistrationTemplate {
  if (schemaIssues('LearnedRegistrationTemplate', value).length) return false;
  const { templateHash, ...body } = value as LearnedRegistrationTemplate;
  return sha(canonical(body)) === templateHash;
}
function image(bytes: Buffer) {
  if (
    bytes.length < 45 ||
    bytes.length > 10485760 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.readUInt32BE(16) > 4096 ||
    bytes.readUInt32BE(20) > 4096
  )
    throw new RegistrationError('AUTO_PAGE_INVALID');
  return PNG.sync.read(bytes, { checkCRC: true });
}
function regionHash(bytes: Buffer, rect: Rect) {
  const png = image(bytes),
    x = Math.floor(rect.x),
    y = Math.floor(rect.y),
    w = Math.ceil(rect.width),
    h = Math.ceil(rect.height);
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > png.width || y + h > png.height)
    throw new RegistrationError('AUTO_PAGE_INVALID');
  const rows = [];
  for (let row = y; row < y + h; row++)
    rows.push(png.data.subarray((row * png.width + x) * 4, (row * png.width + x + w) * 4));
  return sha(Buffer.concat(rows));
}
export async function discoverRegistration(
  session: AndroidSession,
  pkg: string,
  settings: AutoRegistration,
  key: string,
  signal: AbortSignal,
  beforeAction: () => void,
  recognition: RegistrationRecognition,
  learning?: RegistrationLearning,
): Promise<RegistrationDiscovery> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]),
    deadline = Date.now() + settings.timeoutMs;
  const check = () => {
    if (signal.aborted) throw new RegistrationError('CANCELLED');
    if (bounded.aborted || Date.now() >= deadline)
      throw new RegistrationError('AUTO_DISCOVERY_TIMEOUT');
    beforeAction();
  };
  const remain = (max: number) => Math.max(1, Math.min(max, deadline - Date.now()));
  const navigation: LearnedRegistrationTemplate['navigation'] = [],
    visited = new Set<string>();
  try {
    const stored = await learning?.load(key);
    let cached = validLearnedTemplate(stored) ? stored : undefined,
      ocrUsed = false;
    if (stored && !cached) recognition.cache = 'INVALIDATED';
    const pause = () => new Promise<void>((r) => setTimeout(r, 150));
    let source = await session.source(bounded),
      idle = 0;
    for (let observations = 0; observations < 50; observations++) {
      check();
      const page = readRegistrationPage(source, pkg);
      if (page.foreign) throw new RegistrationError('AUTO_FOREIGN_SCREEN');
      await pause();
      const settledSource = await session.source(bounded);
      check();
      if (readRegistrationPage(settledSource, pkg).hash !== page.hash) {
        source = settledSource;
        continue;
      }
      let candidates = registrationEntries(page, pkg),
        picture: Buffer | undefined;
      const consent = candidates.filter((c) => c.role === 'CONSENT');
      const form = consent.length ? undefined : registrationForm(page, pkg);
      if (form) {
        const body = { version: '1.0' as const, navigation, formHash: form.hash },
          template = { ...body, templateHash: sha(canonical(body)) };
        const hit =
          !!cached &&
          cached.formHash === form.hash &&
          cached.navigation.length === navigation.length &&
          cached.templateHash === template.templateHash;
        if (cached && !hit) {
          recognition.cache = 'INVALIDATED';
          await learning?.drop(key);
        }
        recognition.source = hit ? 'LEARNED' : ocrUsed ? 'OCR' : 'CONTROLS';
        recognition.cache = hit ? 'HIT' : recognition.cache;
        recognition.templateHash = template.templateHash;
        return { form, template };
      }
      if (navigation.length >= settings.maxNavigationSteps)
        throw new RegistrationError('AUTO_NAVIGATION_LIMIT');
      if (!candidates.length && settings.screenshotFallback) {
        if (!session.ocr || !session.tap) throw new RegistrationError('AUTO_OCR_UNAVAILABLE');
        check();
        picture = await session.screenshot(bounded);
        image(picture);
        const lines = await session.ocr(picture, bounded);
        check();
        ocrUsed = true;
        recognition.source = 'OCR';
        const privacy = lines.some((line) => /隐私|协议|privacy|terms/i.test(line.text));
        candidates = lines.flatMap((line) => {
          const role = entryRole(line.text);
          if (
            !role ||
            line.confidence < 75 ||
            (role === 'CONSENT' && !privacy) ||
            (role === 'LOGIN' && page.controls.some((e) => e.editable))
          )
            return [];
          const pixels = regionHash(picture!, line.rect);
          return [
            { role, rect: line.rect, hash: sha(canonical({ role, pixels, rect: line.rect })) },
          ];
        });
        const refreshed = await session.source(bounded);
        if (readRegistrationPage(refreshed, pkg).hash !== page.hash) {
          source = refreshed;
          continue;
        }
      }
      const priorities = { CONSENT: 0, REGISTER: 1, ACCOUNT: 2, LOGIN: 3 };
      candidates.sort((a, b) => priorities[a.role] - priorities[b.role]);
      if (!candidates.length) {
        if (idle++ < 3) {
          await new Promise((r) => setTimeout(r, 400));
          source = await session.source(bounded);
          continue;
        }
        throw new RegistrationError('AUTO_ENTRY_NOT_FOUND');
      }
      idle = 0;
      if (
        candidates.length > 1 &&
        priorities[candidates[0].role] === priorities[candidates[1].role]
      )
        throw new RegistrationError('AUTO_ENTRY_AMBIGUOUS');
      const candidate: EntryCandidate = candidates[0],
        step = { screenHash: page.hash, role: candidate.role, candidateHash: candidate.hash };
      const mark = sha(canonical(step));
      check();
      const currentSource = await session.source(bounded);
      if (readRegistrationPage(currentSource, pkg).hash !== page.hash) {
        source = currentSource;
        continue;
      }
      if (visited.has(mark)) throw new RegistrationError('AUTO_NAVIGATION_LOOP');
      if (cached && canonical(cached.navigation[navigation.length]) !== canonical(step)) {
        cached = undefined;
        recognition.cache = 'INVALIDATED';
        await learning?.drop(key);
      }
      if (candidate.locator) {
        const id = await session.find(candidate.locator, remain(2000), bounded);
        check();
        await session.click(id, remain(5000));
      } else {
        if (!picture) throw new RegistrationError('AUTO_SCREEN_CHANGED');
        if (
          regionHash(await session.screenshot(bounded), candidate.rect) !==
          regionHash(picture, candidate.rect)
        ) {
          source = await session.source(bounded);
          continue;
        }
        check();
        await session.tap!(
          Math.round(candidate.rect.x + candidate.rect.width / 2),
          Math.round(candidate.rect.y + candidate.rect.height / 2),
          remain(5000),
        );
      }
      visited.add(mark);
      navigation.push(step);
      recognition.navigationSteps = navigation.length;
      const waitUntil = Date.now() + remain(8000);
      let next: string;
      do {
        check();
        await pause();
        next = await session.source(bounded);
        if (readRegistrationPage(next, pkg).hash !== page.hash) break;
      } while (Date.now() < waitUntil);
      if (readRegistrationPage(next, pkg).hash === page.hash)
        throw new RegistrationError('AUTO_NAVIGATION_STALLED');
      source = next;
    }
    throw new RegistrationError('AUTO_SCREEN_CHANGED');
  } catch (error) {
    if (signal.aborted) throw new RegistrationError('CANCELLED');
    if (bounded.aborted || Date.now() >= deadline)
      throw new RegistrationError('AUTO_DISCOVERY_TIMEOUT');
    throw error;
  }
}
