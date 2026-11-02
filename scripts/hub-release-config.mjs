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
