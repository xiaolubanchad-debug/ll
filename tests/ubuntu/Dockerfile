ARG NODE_IMAGE=node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573
ARG UBUNTU_IMAGE
FROM ${NODE_IMAGE} AS node-runtime
FROM ${UBUNTU_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=node-runtime /usr/local /usr/local
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl python3 python3-venv libstdc++6 libatomic1 sudo unzip openjdk-17-jre-headless
COPY . .
RUN chmod -R a+rX /app && python3 -m venv /opt/ansible && /opt/ansible/bin/pip install --no-cache-dir -r deploy/requirements.txt
RUN /opt/ansible/bin/ansible-playbook -i target, -c local deploy/ansible/install.yml --tags platform_check,system_prerequisites
RUN npm ci --no-audit --no-fund && npm run db:generate && npm run build
RUN node scripts/check-platforms.mjs /opt/ansible/bin/ansible-playbook && node scripts/check-ansible.mjs /opt/ansible/bin/ansible-playbook
RUN npx playwright install --with-deps chromium --only-shell && chmod -R a+rX /ms-playwright
RUN groupadd -g 10001 platform-test && useradd -u 10001 -g 10001 -m platform-test && install -d -o 10001 -g 10001 -m 0700 /app/.tmp && install -d -m 0755 /var/lib/apk-platform
RUN useradd -u 10002 -m apk-runner && install -d -m 0755 /appium-fixture && cp tests/ubuntu/appium-package.json /appium-fixture/package.json && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefix /appium-fixture && npm ci --no-audit --no-fund --prefix /appium-fixture && node scripts/check-appium.mjs /opt/ansible/bin/ansible-playbook /appium-fixture
RUN node scripts/check-sdk-layout.mjs /opt/ansible/bin/ansible-playbook
ENV HOME=/home/platform-test
USER 10001:10001
CMD ["node", "tests/ubuntu/smoke.mjs"]
