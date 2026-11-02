export function validateHubConfig(config) {
  for (const service of ['api', 'worker', 'web', 'tools']) {
    if (!config?.services?.[service]?.image) throw Error('HUB_SERVICE_MISSING');
    if (service === 'worker') continue;
    const args = config.services[service].build?.args;
    if (
      !args ||
      !['NODE_IMAGE', 'NGINX_IMAGE'].every((k) =>
        /^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/.test(args[k] ?? ''),
      )
    )
      throw Error('PINNED_BASE_REQUIRED');
  }
  return config;
}
export function moduleOverrides(config, selected, sha, source, previous = { services: {} }) {
  validateHubConfig(config);
  if (
    !/^[a-f0-9]{12}$/.test(sha) ||
    selected.some((x) => !['api', 'worker', 'web', 'tools'].includes(x))
  )
    throw Error('HUB_MODULE_INVALID');
  const result = structuredClone(previous);
  for (const service of selected)
    result.services[service] = {
      ...result.services[service],
      image: `apk-hub-${service}:${sha}`,
      build: {
        context: source,
        dockerfile: 'deploy/hub/Dockerfile',
        target: service,
        args: config.services[service === 'worker' ? 'api' : service].build.args,
      },
    };
  return result;
}
export function manualUploadOverrides(config, previous) {
  const result = structuredClone(previous);
  for (const service of ['api', 'worker']) {
    const old = result.services[service] ?? {};
    result.services[service] = {
      ...old,
      environment: { ...old.environment, APK_UPLOAD_DIR: '/var/lib/apk-hub/apk-uploads' },
      volumes: [
        ...(old.volumes ?? []).filter(
          (v) =>
            (typeof v === 'string' ? v.split(':')[1] : v.target) !== '/var/lib/apk-hub/apk-uploads',
        ),
        {
          type: 'bind',
          source: '/opt/apk-hub/state/apk-uploads',
          target: '/var/lib/apk-hub/apk-uploads',
          read_only: service === 'worker',
        },
      ],
    };
    if (!config.services[service]) throw Error('HUB_SERVICE_MISSING');
  }
  return result;
}
export function manualUploadNginx(text) {
  if (text.includes('# APK_MANUAL_UPLOAD_V1')) return text;
  if ((text.match(/location \/api\/ \{/g) ?? []).length !== 1) throw Error('NGINX_LAYOUT_INVALID');
  return text.replace(
    'location /api/ {',
    `# APK_MANUAL_UPLOAD_V1
  location ~ "^/api/v1/apk-uploads/[a-f0-9-]{36}/file$" {
    client_max_body_size 512m;
    client_body_timeout 120s;
    proxy_request_buffering off;
    proxy_pass http://api:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_http_version 1.1;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
  }
  location /api/ {`,
  );
}
