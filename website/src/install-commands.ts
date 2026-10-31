const CURL_OPTIONS = "--proto '=https' --tlsv1.2 -fsSL";

export const NPM_INSTALL_COMMAND = "npm install --global agemon";

export function curlInstallCommand(site: URL | undefined): string {
  return `curl ${CURL_OPTIONS} ${new URL("/install.sh", site).href} | sh`;
}
