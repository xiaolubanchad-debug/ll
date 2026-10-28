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
const p1 = await json('contracts/p1.schema.json');
const p1Http = await json('contracts/p1.http.json');
manifest.routes.push(...p1Http.routes);
const p2 = await json('contracts/p2.schema.json'),
  p2Http = await json('contracts/p2.http.json');
manifest.routes.push(...p2Http.routes);
manifest.version = p2Http.version;
const p3 = await json('contracts/p3.schema.json'),
  p3Http = await json('contracts/p3.http.json');
manifest.routes.push(...p3Http.routes);
manifest.version = p3Http.version;
const v15 = await json('contracts/v15.schema.json'),
  v15Http = await json('contracts/v15.http.json');
manifest.routes.push(...v15Http.routes);
manifest.version = v15Http.version;
const v16 = await json('contracts/v16.schema.json'),
  v16Http = await json('contracts/v16.http.json');
manifest.routes.push(...v16Http.routes);
manifest.version = v16Http.version;
const v17 = await json('contracts/v17.schema.json'),
  v17Http = await json('contracts/v17.http.json');
manifest.routes.push(...v17Http.routes);
manifest.version = v17Http.version;
const schemas = {
  ...Object.fromEntries(
    Object.entries(v17.$defs).map(([name, value]) => [
      name,
      { ...value, $id: v17.$id + '/' + name },
    ]),
  ),
  TestConfiguration: config,
  AgentMessage: agent,
  LoginInput: { ...auth.$defs.login, $id: auth.$id + '/login' },
  PasswordChangeInput: { ...auth.$defs.passwordChange, $id: auth.$id + '/passwordChange' },
  ...Object.fromEntries(
    Object.entries(p1.$defs).map(([name, value]) => [name, { ...value, $id: p1.$id + '/' + name }]),
  ),
  ...Object.fromEntries(
    Object.entries(p2.$defs).map(([name, value]) => [name, { ...value, $id: p2.$id + '/' + name }]),
  ),
  ...Object.fromEntries(
    Object.entries(p3.$defs).map(([name, value]) => [name, { ...value, $id: p3.$id + '/' + name }]),
  ),
  ...Object.fromEntries(
    Object.entries(v15.$defs).map(([name, value]) => [
      name,
      { ...value, $id: v15.$id + '/' + name },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(v16.$defs).map(([name, value]) => [
      name,
      { ...value, $id: v16.$id + '/' + name },
    ]),
  ),
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
        ignoreMinAndMaxItems: true,
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
  NodeList: list(normalize(p1.$defs.NodeView, 'NodeView')),
  RunList: list(
    fields({
      id: str,
      nodeId: str,
      status: str,
      purpose: str,
      cacheDay: { type: ['string', 'null'] },
      configVersionId: { type: ['string', 'null'] },
      successTarget: { type: 'integer' },
      attemptLimit: { type: 'integer' },
      attemptsStarted: { type: 'integer' },
      successes: { type: 'integer' },
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
          ignoreMinAndMaxItems: true,
          style: { singleQuote: true },
        }),
      ),
  )
).join('\n');
const paths = {};
for (const route of manifest.routes) {
  const operation = {
    operationId: route.operationId,
    'x-phase': v17Http.routes.some((r) => r.operationId === route.operationId)
      ? '1.7'
      : v15Http.routes.some((r) => r.operationId === route.operationId)
        ? '1.5'
        : p3Http.routes.some((r) => r.operationId === route.operationId)
          ? 'P3'
          : p2Http.routes.some((r) => r.operationId === route.operationId)
            ? 'P2'
            : p1Http.routes.some((r) => r.operationId === route.operationId)
              ? 'P1'
              : 'P0',
    security: route.node
      ? [{ NodeBearer: [] }]
      : route.public || route.internal
        ? []
        : [{ AdminSession: [] }],
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
  if (['post', 'put', 'patch', 'delete'].includes(route.method) && !route.node)
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
  operation.parameters ??= [];
  if (route.query) {
    const querySchema = schemas[route.query];
    operation.parameters.push(
      ...Object.entries(querySchema.properties).map(([name, schema]) => ({
        in: 'query',
        name,
        schema,
        required: false,
      })),
    );
  }
  for (const name of [...route.path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]))
    operation.parameters.push({
      in: 'path',
      name,
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  if (route.idempotent)
    operation.parameters.push({
      in: 'header',
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', minLength: 8, maxLength: 128 },
    });
  if (route.ifMatch)
    operation.parameters.push({
      in: 'header',
      name: 'If-Match',
      required: true,
      schema: { type: 'string' },
    });
  (paths['/api/v1' + route.path] ??= {})[route.method] = operation;
}
const openapi = {
  openapi: '3.1.0',
  info: { title: 'APK 部署中台 API', version: manifest.version },
  paths,
  components: {
    securitySchemes: {
      AdminSession: { type: 'apiKey', in: 'cookie', name: 'apk_session' },
      NodeBearer: { type: 'http', scheme: 'bearer' },
    },
    schemas: apiSchemas,
  },
};
const outputs = {
  'packages/contracts/src/generated/types.ts':
    '// Generated. Run npm run generate:contracts.\n' + types + '\n' + responseTypes,
  'packages/contracts/src/generated/validators.js':
    '// Generated standalone validators; no runtime eval.\n' + bundle.outputFiles[0].text,
  'packages/contracts/src/generated/validators.d.ts': `import type { ValidateFunction } from 'ajv';\ndeclare const validators: Record<${Object.keys(
    schemas,
  )
    .map((x) => JSON.stringify(x))
    .join(' | ')}, ValidateFunction>;\nexport default validators;\n`,
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
      : 'Generated types, validators and OpenAPI.',
  );
