import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standalone from 'ajv/dist/standalone/index.js';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async (name) => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
const config = await json('contracts/config.schema.json');
const agent = await json('contracts/agent.schema.json');
const auth = await json('contracts/auth.schema.json');
const manifest = await json('contracts/p0.http.json');
const schemas = {
  TestConfiguration: config,
  AgentMessage: agent,
  LoginInput: { ...auth.$defs.login, $id: auth.$id + '/login' },
  PasswordChangeInput: { ...auth.$defs.passwordChange, $id: auth.$id + '/passwordChange' },
};
const ajv = new Ajv({
  strict: true,
  strictRequired: false,
  code: { source: true },
  allErrors: true,
});
addFormats(ajv);
for (const schema of Object.values(schemas)) ajv.addSchema(schema);
const source = standalone(
  ajv,
  Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, schema.$id])),
);
const bundle = await build({
  stdin: { contents: source, resolveDir: root },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  write: false,
  minify: true,
  legalComments: 'none',
});
// Conditional presence constraints remain enforced by generated runtime validators.
// The TS emitter cannot represent if/then/else reliably, so emit the structural shape.
function structuralShape(schema) {
  const copy = structuredClone(schema);
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.allOf) {
      value.allOf = value.allOf.filter((entry) => !entry.if);
      if (!value.allOf.length) delete value.allOf;
    }
    delete value.if;
    delete value.then;
    delete value.else;
    for (const child of Object.values(value)) walk(child);
  };
  walk(copy);
  return copy;
}
const types = (
  await Promise.all(
    Object.entries(schemas).map(([name, schema]) =>
      compile({ ...structuralShape(schema), title: name }, name, {
        bannerComment: '',
        declareExternallyReferenced: true,
        style: { singleQuote: true },
      }),
    ),
  )
).join('\n');
function normalize(schema, name) {
  const copy = JSON.parse(JSON.stringify(schema));
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref?.startsWith('#/'))
      value.$ref = `#/components/schemas/${name}/${value.$ref.slice(2)}`;
    for (const child of Object.values(value)) walk(child);
  }
  walk(copy);
  delete copy.$id;
  delete copy.$schema;
  return copy;
}
const list = (item) => ({
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: item }, nextCursor: { type: ['string', 'null'] } },
});
const fields = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const str = { type: 'string' };
const apiSchemas = {
  ...Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, normalize(schema, name)]),
  ),
  SessionView: fields({
    admin: fields({
      id: { type: 'string', format: 'uuid' },
      username: str,
      role: { const: 'SUPER_ADMIN' },
    }),
    csrfToken: str,
  }),
  ValidationResult: fields({ valid: { const: true } }),
  NodeList: list(
    fields({ id: str, name: str, host: str, createdAt: { type: 'string', format: 'date-time' } }),
  ),
  RunList: list(
    fields({
      id: str,
      nodeId: str,
      status: str,
      createdAt: { type: 'string', format: 'date-time' },
    }),
  ),
  AuditList: list(
    fields({ id: str, action: str, createdAt: { type: 'string', format: 'date-time' } }),
  ),
  ApiError: fields({
    error: fields({
      code: str,
      message: str,
      requestId: str,
      details: { type: 'array', items: fields({ path: str, message: str }) },
    }),
  }),
};
const responseTypes = (
  await Promise.all(
    Object.entries(apiSchemas)
      .filter(([name]) => !(name in schemas))
      .map(([name, schema]) =>
        compile({ ...schema, title: name }, name, {
          bannerComment: '',
          style: { singleQuote: true },
        }),
      ),
  )
).join('\n');
const paths = {};
for (const route of manifest.routes) {
  const operation = {
    operationId: route.operationId,
    'x-phase': 'P0',
    security: route.public || route.internal ? [] : [{ AdminSession: [] }],
    responses: {
      [route.status]: {
        description: '成功',
        ...(route.response
          ? {
              content: {
                'application/json': { schema: { $ref: `#/components/schemas/${route.response}` } },
              },
            }
          : {}),
      },
      default: {
        description: '统一错误',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
    },
  };
  if (route.request)
    operation.requestBody = {
      required: true,
      content: {
        'application/json': { schema: { $ref: `#/components/schemas/${route.request}` } },
      },
    };
  if (['post', 'put'].includes(route.method))
    operation.parameters = [
      { in: 'header', name: 'Origin', required: true, schema: { type: 'string' } },
      ...(!route.public
        ? [{ in: 'header', name: 'X-CSRF-Token', required: true, schema: { type: 'string' } }]
        : []),
    ];
  if (['nodes', 'runs', 'audit'].includes(route.operationId))
    operation.parameters = [
      {
        in: 'query',
        name: 'limit',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      { in: 'query', name: 'cursor', schema: { type: 'string', format: 'uuid' } },
    ];
  if (route.internal) operation['x-network-scope'] = 'loopback';
  (paths['/api/v1' + route.path] ??= {})[route.method] = operation;
}
const openapi = {
  openapi: '3.1.0',
  info: { title: 'APK 部署中台 P0 API', version: manifest.version },
  paths,
  components: {
    securitySchemes: { AdminSession: { type: 'apiKey', in: 'cookie', name: 'apk_session' } },
    schemas: apiSchemas,
  },
};
const outputs = {
  'packages/contracts/src/generated/types.ts':
    '// Generated. Run npm run generate:contracts.\n' + types + '\n' + responseTypes,
  'packages/contracts/src/generated/validators.js':
    '// Generated standalone validators; no runtime eval.\n' + bundle.outputFiles[0].text,
  'packages/contracts/src/generated/validators.d.ts':
    "import type { ValidateFunction } from 'ajv';\ndeclare const validators: Record<'TestConfiguration' | 'AgentMessage' | 'LoginInput' | 'PasswordChangeInput', ValidateFunction>;\nexport default validators;\n",
  'contracts/openapi.json': JSON.stringify(openapi, null, 2) + '\n',
};
let drift = false;
for (const [name, text] of Object.entries(outputs)) {
  const full = path.join(root, name);
  if (process.argv.includes('--check')) {
    if ((await fs.readFile(full, 'utf8').catch(() => null)) !== text) {
      console.error(`Contract drift: ${name}`);
      drift = true;
    }
  } else {
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, text);
  }
}
if (drift) process.exitCode = 1;
else
  console.log(
    process.argv.includes('--check')
      ? 'Generated contracts match source.'
      : 'Generated types, validators and P0 OpenAPI.',
  );
