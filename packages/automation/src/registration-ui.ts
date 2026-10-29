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
  locatorControls?: UiControl[];
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
    /^(注册|立即注册|免费注册|注册账号|注册帐号|注册新账号|注册新帐号|注册新用户|账号注册|帐号注册|用户注册|创建账号|创建账户|新用户注册|新用户注册账号|register|registration|signup|signuptoday|createaccount|createanaccount|openregistration)$/.test(
      text,
    )
  )
    return 'REGISTER';
  if (
    /^(我的|我的未登录|个人中心|个人中心未登录|用户中心|账号中心|账户中心|我的账户|me|my|profile|account|myaccount)$/.test(
      text,
    )
  )
    return 'ACCOUNT';
  if (
    /^(登录|登入|未登录|点击登录|立即登录|请登录|点击登录注册|登录注册|注册登录|login|signin|loginsignup|tapto(?:log|sign)in)$/.test(
      text,
    )
  )
    return 'LOGIN';
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
  let window: Rect | undefined;
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
          !window &&
          owner === pkg &&
          level <= 3 &&
          /(?:FrameLayout|LinearLayout|ViewGroup|WebView)$/.test(String(row.class))
        )
          window = { x, y, width: x2 - x, height: y2 - y };
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
    const container = /(?:WebView|ScrollView|RecyclerView|ListView)$/.test(String(row.class));
    for (const child of Object.values(row))
      if (typeof child === 'object')
        visit(child, owner, !container && (ancestorClickable || clickable), level + 1);
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
  const shown = window
    ? controls.filter(
        (e) =>
          e.rect.x < window!.x + window!.width &&
          e.rect.y < window!.y + window!.height &&
          e.rect.x + e.rect.width > window!.x &&
          e.rect.y + e.rect.height > window!.y,
      )
    : controls;
  return {
    controls: shown,
    locatorControls: controls,
    foreign,
    hash: sha(
      canonical(
        shown.map((e) => ({
          ...e,
          packageName: '{packageName}',
          resourceId: stableValue(e.resourceId, pkg),
          className: stableValue(e.className, pkg),
          idCount: e.resourceId ? controls.filter((c) => c.resourceId === e.resourceId).length : 0,
        })),
      ),
    ),
  };
}

export function controlLocator(control: UiControl, page: UiPage): Locator {
  const all = page.locatorControls ?? page.controls;
  if (control.resourceId && all.filter((e) => e.resourceId === control.resourceId).length === 1)
    return { by: 'id', value: control.resourceId };
  // Editable text is the value being changed, never a durable locator.
  if (control.editable) {
    const bounds = `[${control.rect.x},${control.rect.y}][${control.rect.x + control.rect.width},${control.rect.y + control.rect.height}]`;
    if (
      all.filter(
        (e) => e.className === control.className && canonical(e.rect) === canonical(control.rect),
      ).length === 1
    )
      return {
        by: 'xpath',
        value:
          '//*[@package=' +
          literal(control.packageName) +
          ' and @class=' +
          literal(control.className) +
          ' and @bounds=' +
          literal(bounds) +
          ']',
      };
    throw new RegistrationError('AUTO_CONTROL_AMBIGUOUS');
  }
  if (control.description && all.filter((e) => e.description === control.description).length === 1)
    return { by: 'accessibilityId', value: control.description };
  for (const [attr, value, key] of [
    ['text', control.text, 'text'],
    ['hint', control.hint, 'hint'],
  ] as const) {
    if (
      value &&
      all.filter((e) => e[key] === value && e.className === control.className).length === 1
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
  throw new RegistrationError('AUTO_CONTROL_AMBIGUOUS');
}

function fieldName(control: UiControl, page: UiPage): string {
  const own = label(control) + ' ' + compactLabel(control.resourceId.split('/').at(-1) ?? '');
  if (
    /用户名|账号|帐号|账户|密码|username|account|password|passwd|confirmpass|repeatpass/.test(own)
  )
    return own;
  const distance = (field: UiControl, text: UiControl) => {
    const f = field.rect,
      t = text.rect,
      gap = f.y - t.y - t.height;
    if (
      gap >= -f.height / 3 &&
      gap <= Math.max(60, f.height * 1.5) &&
      Math.min(f.x + f.width, t.x + t.width) > Math.max(f.x, t.x)
    )
      return Math.abs(gap);
    if (
      t.x + t.width <= f.x + 10 &&
      f.x - t.x - t.width <= Math.max(120, f.height * 4) &&
      Math.abs(t.y + t.height / 2 - f.y - f.height / 2) <= f.height / 2
    )
      return Math.abs(t.y + t.height / 2 - f.y - f.height / 2);
    return Infinity;
  };
  const nearby = page.controls
    .filter(
      (e) =>
        !e.editable &&
        !e.clickable &&
        labels(e).some((v) =>
          /^(用户名|账号|帐号|账户|登录账号|密码|登录密码|设置密码|确认密码|再次输入密码|重复密码|username|account|password|confirmpassword)$/.test(
            compactLabel(v),
          ),
        ),
    )
    .flatMap((e) => {
      const ranked = page.controls
        .filter((c) => c.editable)
        .map((c) => ({ c, d: distance(c, e) }))
        .sort((a, b) => a.d - b.d);
      return ranked[0]?.c === control &&
        Number.isFinite(ranked[0].d) &&
        (!ranked[1] || ranked[1].d > ranked[0].d + 1)
        ? [e]
        : [];
    });
  return nearby.length === 1 ? own + ' ' + label(nearby[0]) : own;
}

export interface RegistrationForm {
  username: Locator;
  password: Locator;
  confirm?: Locator;
  agreement?: Locator;
  submit: Locator;
  hash: string;
}
export function registrationBindingsValid(
  page: UiPage,
  form: RegistrationForm,
  allowDisabledSubmit = false,
): boolean {
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
    (!allowDisabledSubmit && !submits[0].enabled) ||
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
    buttons.some((e) => labels(e).some((v) => entryRole(v) === 'LOGIN')) &&
    !page.controls.some(
      (e) => !e.editable && !e.clickable && labels(e).some((v) => entryRole(v) === 'REGISTER'),
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
  const named = (e: UiControl) => fieldName(e, page);
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

export function automaticIdentity(
  page: UiPage,
): { value: string; kind: 'GUEST' | 'APP_ASSIGNED'; rects: Rect[] } | undefined {
  if (page.foreign) return undefined;
  const context = page.controls.flatMap(labels).map(compactLabel);
  if (
    !context.some((s) =>
      /^(我的|个人中心|用户中心|账号信息|账户信息|我的账户|游客|guest|profile|account)$/.test(s),
    )
  )
    return undefined;
  const found: { value: string; rects: Rect[] }[] = [];
  const usable = (value: string) =>
    /[A-Za-z0-9]/.test(value) &&
    !/^0+$/.test(value) &&
    !/^(null|none|undefined|unknown|guest)$/i.test(value);
  for (const c of page.controls.filter((e) => !e.editable))
    for (const text of labels(c)) {
      const match = text
        .trim()
        .match(
          /^(?:用户\s*ID|用户编号|账号\s*ID|账户\s*ID|UID|User\s*ID|Account\s*ID)\s*[:：#]?\s*([A-Za-z0-9_-]{1,64})$/i,
        );
      if (match && usable(match[1])) found.push({ value: match[1], rects: [c.rect] });
      else if (
        /^(用户\s*ID|用户编号|账号\s*ID|账户\s*ID|UID|User\s*ID|Account\s*ID)\s*[:：#]?$/i.test(
          text.trim(),
        )
      ) {
        const nearby = page.controls.filter(
          (e) =>
            !e.editable &&
            /^[A-Za-z0-9_-]{1,64}$/.test(e.text.trim()) &&
            usable(e.text.trim()) &&
            e.rect.x >= c.rect.x + c.rect.width &&
            e.rect.x - c.rect.x - c.rect.width <= Math.max(120, c.rect.height * 6) &&
            Math.abs(e.rect.y - c.rect.y) <= c.rect.height / 2,
        );
        if (nearby.length === 1)
          found.push({ value: nearby[0].text.trim(), rects: [c.rect, nearby[0].rect] });
      }
    }
  if (new Set(found.map((f) => f.value)).size !== 1) return undefined;
  return {
    value: found[0].value,
    kind: context.some((s) => /游客|^guest$|匿名账户/.test(s)) ? 'GUEST' : 'APP_ASSIGNED',
    rects: found.flatMap((f) => f.rects),
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
    const id = e.resourceId.split('/').at(-1)?.toLowerCase() ?? '';
    const semantic = /^(?:btn_|tab_|nav_|iv_|tv_)?(?:register|signup|sign_up)$/.test(id)
      ? 'REGISTER'
      : /^(?:btn_|tab_|nav_|iv_|tv_)?(?:login|sign_in|signin)$/.test(id)
        ? 'LOGIN'
        : /^(?:btn_|tab_|nav_|iv_|tv_)?(?:me|mine|my|profile|user_center|account_center)$/.test(id)
          ? 'ACCOUNT'
          : undefined;
    if (
      semantic &&
      !labels(e).some((v) => /注销|删除|充值|购买|退出|logout|delete|purchase/i.test(v))
    )
      roles.add(semantic);
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
      if (
        !candidates.some(
          (v) => v.hash === hash || (v.role === role && canonical(v.rect) === canonical(e.rect)),
        )
      )
        candidates.push({ role, locator, rect: e.rect, hash });
    }
  }
  return candidates;
}

export function appNavigationPage(page: UiPage): boolean {
  if (
    page.foreign ||
    page.controls.some((e) => e.editable) ||
    registrationEntries(page, page.controls[0]?.packageName ?? '').length
  )
    return false;
  const headings = page.controls.flatMap(labels).map(compactLabel);
  const markers = new Set(
    headings.filter((s) =>
      /^(热门推荐|应用推荐|app导航|软件导航|应用大全|站长精选.*|站长推荐.*|下载中心|免费看片.*|appdirectory)$/.test(
        s,
      ),
    ),
  );
  const links = new Set(
    page.controls
      .filter((e) => e.clickable && labels(e).length)
      .map((e) => canonical([e.rect, labels(e)])),
  );
  return markers.size >= 2 && links.size >= 8;
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
