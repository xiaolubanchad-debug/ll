import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Locator, Rect, Account } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
import { canonical, sha } from './common.js';

export type EntryRole = 'REGISTER' | 'ACCOUNT' | 'LOGIN' | 'CONSENT';
export interface UiControl {
  className: string;
  text: string;
  description: string;
  hint: string;
  resourceId: string;
  editable: boolean;
  enabled: boolean;
  password: boolean;
  clickable: boolean;
  checkable: boolean;
  checked?: boolean;
  rect: Rect;
  packageName: string;
}
export interface UiPage {
  controls: UiControl[];
  hash: string;
  foreign: boolean;
}
export const compactLabel = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-:：/！!。.,，()（）]+/g, '');
export function entryRole(value: string): EntryRole | undefined {
  const text = compactLabel(value);
  if (
    /^(注册|立即注册|免费注册|注册账号|注册帐号|账号注册|帐号注册|用户注册|创建账号|创建账户|新用户注册|register|registration|signup|signuptoday|createaccount|createanaccount|openregistration)$/.test(
      text,
    )
  )
    return 'REGISTER';
  if (
    /^(我的|个人中心|用户中心|账号中心|账户中心|我的账户|me|my|profile|account|myaccount)$/.test(
      text,
    )
  )
    return 'ACCOUNT';
  if (/^(登录|登入|登录注册|注册登录|login|signin|loginsignup)$/.test(text)) return 'LOGIN';
  if (
    /^(同意|同意并继续|同意并使用|接受|agree|accept|acceptandcontinue|agreeandcontinue)$/.test(text)
  )
    return 'CONSENT';
  return undefined;
}
export const labels = (e: UiControl) => [e.text, e.description, e.hint].filter(Boolean);
const label = (e: UiControl) => labels(e).map(compactLabel).join(' ');
export const stableValue = (value: string, pkg: string) => value.replaceAll(pkg, '{packageName}');
const literal = (value: string) =>
  !value.includes("'")
    ? "'" + value + "'"
    : !value.includes('"')
      ? '"' + value + '"'
      : 'concat(' +
        value
          .split("'")
          .map((v) => "'" + v + "'")
          .join(',"\'",') +
        ')';

export function readRegistrationPage(source: string, pkg: string): UiPage {
  if (Buffer.byteLength(source) > 2097152 || /<!DOCTYPE|<!ENTITY/i.test(source))
    throw new RegistrationError('AUTO_PAGE_INVALID');
  let depth = 0,
    count = 0;
  for (const match of source.matchAll(/<\/?[A-Za-z][^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith('</')) depth--;
    else if (!tag.endsWith('/>')) depth++;
    if (++count > 10000 || depth > 50 || depth < 0)
      throw new RegistrationError('AUTO_PAGE_INVALID');
  }
  if (XMLValidator.validate(source) !== true) throw new RegistrationError('AUTO_PAGE_INVALID');
  const controls: UiControl[] = [];
  let foreign = false;
  const visit = (value: unknown, parentPackage = '', ancestorClickable = false, level = 0) => {
    if (!value || typeof value !== 'object' || level > 55) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, parentPackage, ancestorClickable, level);
      return;
    }
    const row = value as Record<string, unknown>;
    const owner = String(row.package ?? parentPackage),
      clickable = row.clickable === 'true';
    const bounds = String(row.bounds ?? '').match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    if (bounds && row.displayed !== 'false') {
      const [x, y, x2, y2] = bounds.slice(1).map(Number);
      if (x2 > x && y2 > y && x2 <= 16384 && y2 <= 16384) {
        if (
          owner &&
          owner !== pkg &&
          owner !== 'com.android.systemui' &&
          (clickable || String(row.class).includes('EditText'))
        )
          foreign = true;
        if (owner === pkg) {
          const text = String(row.text ?? ''),
            description = String(row['content-desc'] ?? ''),
            hint = String(row.hint ?? '');
          if (
            [text, description, hint, String(row['resource-id'] ?? '')].some((v) => v.length > 4096)
          )
            throw new RegistrationError('AUTO_PAGE_INVALID');
          controls.push({
            className: String(row.class ?? ''),
            text,
            description,
            hint,
            resourceId: String(row['resource-id'] ?? ''),
            editable: String(row.class ?? '').includes('EditText') || row.editable === 'true',
            enabled: row.enabled !== 'false',
            password: row.password === 'true',
            clickable: clickable || ancestorClickable,
            checkable: row.checkable === 'true' || String(row.class ?? '').includes('CheckBox'),
            ...(row.checked === 'true' || row.checked === 'false'
              ? { checked: row.checked === 'true' }
              : {}),
            rect: { x, y, width: x2 - x, height: y2 - y },
            packageName: owner,
          });
        }
      }
    }
    if (controls.length > 5000) throw new RegistrationError('AUTO_PAGE_INVALID');
    for (const child of Object.values(row))
      if (typeof child === 'object') visit(child, owner, ancestorClickable || clickable, level + 1);
  };
  visit(
    new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseTagValue: false,
      parseAttributeValue: false,
      processEntities: false,
    }).parse(source),
  );
  return {
    controls,
    foreign,
    hash: sha(
      canonical(
        controls.map((e) => ({
          ...e,
          packageName: '{packageName}',
          resourceId: stableValue(e.resourceId, pkg),
          className: stableValue(e.className, pkg),
        })),
      ),
    ),
  };
}

export function controlLocator(control: UiControl, page: UiPage): Locator {
  if (
    control.resourceId &&
    page.controls.filter((e) => e.resourceId === control.resourceId).length === 1
  )
    return { by: 'id', value: control.resourceId };
  if (
    control.description &&
    page.controls.filter((e) => e.description === control.description).length === 1
  )
    return { by: 'accessibilityId', value: control.description };
  for (const [attr, value, key] of [
    ['text', control.text, 'text'],
    ['hint', control.hint, 'hint'],
  ] as const) {
    if (
      value &&
      page.controls.filter((e) => e[key] === value && e.className === control.className).length ===
        1
    )
      return {
        by: 'xpath',
        value:
          '//*[@package=' +
          literal(control.packageName) +
          ' and @class=' +
          literal(control.className) +
          ' and @' +
          attr +
          '=' +
          literal(value) +
          ']',
      };
  }
  if (
    control.editable &&
    page.controls.filter((e) => e.editable && e.password === control.password).length === 1
  )
    return {
      by: 'xpath',
      value:
        '//*[@package=' +
        literal(control.packageName) +
        ' and @class=' +
        literal(control.className) +
        ' and @password=' +
        literal(String(control.password)) +
        ']',
    };
  throw new RegistrationError('AUTO_CONTROL_AMBIGUOUS');
}

export interface RegistrationForm {
  username: Locator;
  password: Locator;
  confirm?: Locator;
  agreement?: Locator;
  submit: Locator;
  hash: string;
}
export function registrationBindingsValid(page: UiPage, form: RegistrationForm): boolean {
  if (page.foreign) return false;
  const match = (locator: Locator) =>
    page.controls.filter((control) => {
      try {
        return canonical(controlLocator(control, page)) === canonical(locator);
      } catch {
        return false;
      }
    });
  const users = match(form.username),
    passwords = match(form.password),
    confirms = form.confirm ? match(form.confirm) : [],
    submits = match(form.submit);
  if (
    users.length !== 1 ||
    !users[0].editable ||
    !users[0].enabled ||
    users[0].password ||
    passwords.length !== 1 ||
    !passwords[0].editable ||
    !passwords[0].enabled ||
    (form.confirm && (confirms.length !== 1 || !confirms[0].editable)) ||
    page.controls.filter((e) => e.editable).length !== (form.confirm ? 3 : 2) ||
    submits.length !== 1 ||
    !submits[0].clickable ||
    !submits[0].enabled ||
    !labels(submits[0]).some((v) => entryRole(v) === 'REGISTER')
  )
    return false;
  if (form.agreement) {
    const checks = match(form.agreement);
    if (checks.length !== 1 || checks[0].checked !== true) return false;
  }
  return true;
}
export function registrationForm(page: UiPage, pkg: string): RegistrationForm | undefined {
  const edits = page.controls.filter((e) => e.editable);
  const unsafe =
    /手机号|手机号码|电话|邮箱|邮件|验证码|短信|phone|mobile|email|captcha|verificationcode|otp/;
  if (edits.some((e) => unsafe.test(label(e) + ' ' + compactLabel(e.resourceId))))
    throw new RegistrationError('AUTO_FORM_UNSUPPORTED');
  const buttons = page.controls.filter((e) => !e.editable && e.clickable);
  if (
    buttons.some((e) =>
      /^(发送验证码|获取验证码|sendcode|sendverificationcode)$/.test(compactLabel(e.text)),
    )
  )
    throw new RegistrationError('AUTO_FORM_UNSUPPORTED');
  // A link to sign up beside a login form is navigation, not a registration submission.
  if (
    buttons.some(
      (e) => e.className.endsWith('Button') && labels(e).some((v) => entryRole(v) === 'LOGIN'),
    )
  )
    return undefined;
  const submits = buttons.filter(
    (e) =>
      labels(e).some((v) => entryRole(v) === 'REGISTER') &&
      (e.className.endsWith('Button') ||
        page.controls.some(
          (title) => !title.clickable && labels(title).some((v) => entryRole(v) === 'REGISTER'),
        )),
  );
  if (!edits.length || !submits.length) return undefined;
  const named = (e: UiControl) =>
    label(e) + ' ' + compactLabel(e.resourceId.split('/').at(-1) ?? '');
  const confirm = edits.filter((e) =>
    /确认密码|重复密码|再次.*密码|confirmpass|repeatpass|retypepass|passwordconfirm|passwordagain/.test(
      named(e),
    ),
  );
  const passwords = edits.filter(
    (e) => !confirm.includes(e) && (e.password || /密码|password|passwd/.test(named(e))),
  );
  const users = edits.filter(
    (e) =>
      !e.password &&
      !passwords.includes(e) &&
      !confirm.includes(e) &&
      /用户名|用户名称|账号|帐号|账户|username|user(name)?input|account/.test(named(e)),
  );
  if (
    submits.length !== 1 ||
    users.length !== 1 ||
    passwords.length !== 1 ||
    confirm.length > 1 ||
    edits.length !== users.length + passwords.length + confirm.length ||
    edits.some((e) => !e.enabled)
  )
    throw new RegistrationError('AUTO_FORM_AMBIGUOUS');
  const checks = page.controls.filter((e) => e.checkable && e.checked !== true);
  if (
    checks.length > 1 ||
    checks.some(
      (e) => e.checked !== false || !/同意|阅读|协议|隐私|agree|terms|privacy/.test(label(e)),
    )
  )
    throw new RegistrationError('AUTO_FORM_AMBIGUOUS');
  const result = {
    username: controlLocator(users[0], page),
    password: controlLocator(passwords[0], page),
    ...(confirm.length ? { confirm: controlLocator(confirm[0], page) } : {}),
    ...(checks.length ? { agreement: controlLocator(checks[0], page) } : {}),
    submit: controlLocator(submits[0], page),
  };
  return {
    ...result,
    hash: sha(
      canonical(
        Object.fromEntries(
          Object.entries(result).map(([k, v]) => [k, { ...v, value: stableValue(v.value, pkg) }]),
        ),
      ),
    ),
  };
}

export interface EntryCandidate {
  role: EntryRole;
  locator?: Locator;
  rect: Rect;
  hash: string;
}
export function registrationEntries(page: UiPage, pkg: string): EntryCandidate[] {
  const candidates: EntryCandidate[] = [];
  const privacy = page.controls.some((e) =>
    /隐私|协议|privacy|terms/i.test(e.text + ' ' + e.description),
  );
  for (const e of page.controls.filter(
    (e) => e.enabled && e.clickable && !e.editable && !e.checkable,
  )) {
    const roles = new Set(
      labels(e)
        .map(entryRole)
        .filter((v): v is EntryRole => !!v),
    );
    for (const role of roles) {
      if (
        (role === 'CONSENT' && !privacy) ||
        (role === 'LOGIN' && page.controls.some((v) => v.editable))
      )
        continue;
      const locator = controlLocator(e, page);
      const hash = sha(
        canonical({ role, locator: { ...locator, value: stableValue(locator.value, pkg) } }),
      );
      if (!candidates.some((v) => v.hash === hash))
        candidates.push({ role, locator, rect: e.rect, hash });
    }
  }
  return candidates;
}
const successText =
  /^(注册成功[！!。.]?|账号注册成功[！!。.]?|账户创建成功[！!。.]?|Registration successful[!.]?|Registration succeeded[!.]?|Account created[!.]?|Account created successfully[!.]?|Successfully registered[!.]?)$/i;
const failureText =
  /^(注册失败.*|用户名已存在.*|账号已存在.*|帐号已存在.*|用户名已被使用.*|账户已存在.*|Registration failed.*|Username already exists.*|Account already exists.*|Username (is )?(already )?taken.*|Rejected)$/i;
export function registrationOutcome(
  source: string,
  pkg: string,
  account: Account,
  before: string,
): 'SUCCEEDED' | 'FAILED' | undefined {
  const page = readRegistrationPage(source, pkg),
    initial = readRegistrationPage(before, pkg);
  if (page.foreign) return undefined;
  const visible = page.controls.filter((e) => !e.editable).flatMap(labels);
  const prior = new Set(
    initial.controls
      .filter((e) => !e.editable)
      .flatMap(labels)
      .map((s) => s.trim()),
  );
  const success =
    visible.some((s) => successText.test(s.trim()) && !prior.has(s.trim())) ||
    (!page.controls.some((e) => e.editable) &&
      visible.some((s) => s.trim() === account.username) &&
      visible.some((s) =>
        /^(退出登录|退出账号|注销登录|logout|log out|sign out)$/i.test(s.trim()),
      ));
  const failure = visible.some((s) => failureText.test(s.trim()) && !prior.has(s.trim()));
  return success === failure ? undefined : success ? 'SUCCEEDED' : 'FAILED';
}
